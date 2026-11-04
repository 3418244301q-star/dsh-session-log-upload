/**
 * AUDIT-core-parity.mjs — 把 app.asar 里的核心包原样跑起来，与本插件的分段结果逐字节对账。
 *
 * 背景：tools/check-envelope.mjs 是自比较（参考实现是插件的同源拷贝），证明不了与核心等价。
 * 「asar 打不开」这个前提是错的：app.asar 是一个 pickle —— 8 字节头 + JSON 目录 + 连续文件块。
 * 目录形式（app.asar/dsh/...）是虚拟路径，Node/shell 确实打不开；但按偏移读文件本体完全可行。
 *
 * 做法：读 asar 头 → 定位 dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js
 *      → 仅把三个 @deepseek-ai import 换成等价 stub（其余逐字保留）
 *      → import 它，用假 ctx 捕获 prepare()
 *      → 对同一批会话、同一水位、同一 maxBytes 比较 prepare() 与本插件 segment() 的 JSON 输出
 *
 * 不覆盖：插件独有的官方边界截断（stopBefore）与触发/调度逻辑——那些不属于核心。
 *
 * 用法：node tools/check-core-parity.mjs
 *       DSH_ASAR=<path/to/app.asar> node tools/check-core-parity.mjs   # 自定义安装位置
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ASAR = process.env.DSH_ASAR ?? path.join(
  process.env.LOCALAPPDATA ?? '',
  'Programs/DeepSeek Harness/resources/app.asar',
);
const PLUGIN = new URL('../index.js', import.meta.url).href;
const STORE = new URL('./reference/store.mjs', import.meta.url).href;

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}
用 DSH_ASAR 环境变量指定 DSH 安装目录下的 app.asar。`);
  process.exit(2);
}

const fd = fs.openSync(ASAR, 'r');
const sb = Buffer.alloc(8);
fs.readSync(fd, sb, 0, 8, 0);
const size = sb.readUInt32LE(4);
const hb = Buffer.alloc(size);
fs.readSync(fd, hb, 0, size, 8);
const header = JSON.parse(hb.toString('utf8', 8, 8 + hb.readUInt32LE(4)));
const dataOffset = 8 + size;

function walk(node, prefix, out) {
  for (const [name, info] of Object.entries(node.files ?? {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (info.files) walk(info, p, out);
    else if (info.offset !== undefined) out.set(p, { offset: Number(info.offset), size: Number(info.size) });
  }
}
const entries = new Map();
walk(header, '', entries);

function readAsar(path) {
  const e = entries.get(path);
  if (!e) return null;
  const b = Buffer.alloc(e.size);
  fs.readSync(fd, b, 0, e.size, dataOffset + e.offset);
  return b.toString('utf8');
}

let src = readAsar('dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js');
if (!src) {
  console.error('core package not found in asar');
  process.exit(2);
}

/* 核心已知事件类型表：从 asar 里同包源码抄出的真实清单，不是插件里那张 17 条的副本。 */
const KNOWN = 'agent-preset/selected approval/asked approval/decided approval/policy assistant/attempt assistant/message command/done command/run compaction/end compaction/prune compaction/start compaction/summary deliverables/presented developer/message feedback/message-delete feedback/message-put feedback/record goal/change hook/invoked hook/result image/offload job/registered job/settled llm/retry llm/retry-started model/selection permission/preset plan/mode request/context request/header sandbox/mode schedule/change session-log-deepseek/delivery-accepted session/end-seed session/title session/title-llm-request step/end step/start subagent/catalog subagent/descriptor subagent/model-selection-policy system/message team/member team/task todo/write tool-workflow/agent-end tool-workflow/agent-start tool-workflow/run-end tool-workflow/run-start tool/call tool/ptc-dispatch tool/ptc-dispatch-start tool/result turn/end turn/start user/message web/deepseek-search-llm-request working-directory/change workspace/changes';

const preamble = [
  'const z = new Proxy(function () {}, { get: () => z, apply: () => z, set: () => true, construct: () => z });',
  'const brandString = (s) => s;',
  'const KNOWN_SESSION_EVENT_TYPES = new Set(' + JSON.stringify(KNOWN.split(' ')) + ');',
  'const SessionLogOffset = (n) => n;',
  'const SessionSeq = (n) => n;',
].join('\n');

src = src
  .replace(/^import z from "@deepseek-ai\/schemastery";$/m, '')
  .replace(/^import \{ brandString \} from "@deepseek-ai\/dsh-brand";$/m, '')
  .replace(/^import \{ KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq \} from "@deepseek-ai\/dsh-session";$/m, '');
if (/^import .*@deepseek-ai/m.test(src)) {
  console.error('import rewrite failed');
  process.exit(2);
}

const extracted = path.join(os.tmpdir(), 'core-extracted.mjs');
fs.writeFileSync(extracted, preamble + '\n' + src);

const core = await import(pathToFileURL(extracted).href);
const { __internals } = await import(PLUGIN);
const store = await import(STORE);

let prepare = null;
const byId = new Map();
const ctx = {
  logger: { warn() {} },
  deepseekLlmApiExtensions: { register: (field, impl) => { prepare = impl.prepare; } },
  sessions: { get: (id) => byId.get(String(id)) },
};

function fakeSession(headerObj, events) {
  const s = {
    header: headerObj,
    id: headerObj.id,
    seq: events.length,
    inheritedEventCount: store.inheritedEventCount(events),
    eventAt: (i) => events[i],
    snapshotEvents: (f = 0) => events.filter((e) => Number(e.seq) >= Number(f)),
    append() {},
  };
  byId.set(String(headerObj.id), s);
  return s;
}

const files = store.listSessionFiles();
let compared = 0;
let mismatched = 0;
let coreThrew = 0;
const samples = [];

for (const maxBytes of [2000, 8192, 1 << 20, 8 << 20]) {
  core.apply(ctx, { enabled: { get: () => true }, maxBytes });
  if (!prepare) {
    console.error('prepare not captured');
    process.exit(2);
  }
  for (const file of files) {
    let parsed;
    try {
      parsed = store.readSession(file);
    } catch {
      continue;
    }
    const session = fakeSession(parsed.header, parsed.events);
    const after = store.acceptedThrough(parsed.header, parsed.events);
    let coreOut;
    try {
      coreOut = prepare({ sessionId: session.id });
    } catch (error) {
      coreThrew += 1;
      if (samples.length < 3) samples.push('core threw: ' + error.message);
      continue;
    }
    const mine = __internals.segment(session, after, maxBytes);
    compared += 1;
    const a = coreOut ? JSON.stringify(coreOut.value) : null;
    const b = mine.envelope ? JSON.stringify(mine.envelope) : null;
    if (a !== b) {
      mismatched += 1;
      if (samples.length < 3) {
        samples.push(file + ' @ maxBytes=' + maxBytes + '\n  core=' + String(a).slice(0, 240) + '\n  mine=' + String(b).slice(0, 240));
      }
    }
  }
}

console.log('sessions            ' + files.length);
console.log('comparisons         ' + compared);
console.log('core errors         ' + coreThrew);
console.log('mismatches          ' + mismatched);
for (const sample of samples) console.log('---\n' + sample);
process.exit(mismatched === 0 && coreThrew === 0 ? 0 : 1);
