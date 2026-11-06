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
import { openAsar } from './asar.mjs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = new URL('../index.js', import.meta.url).href;
const STORE = new URL('./reference/store.mjs', import.meta.url).href;

let asar;
try {
  asar = openAsar();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}
/** 装机核心包版本：也报出来，省得靠猜「这份 asar 是哪个版本」。 */
const coreVersion = asar.version('dsh/node_modules/@deepseek-ai/dsh/package.json');

let src = asar.read('dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js');
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
  // dsh 0.2.2-rc.1 起核心把上传器改成 Service：构造时调 super(ctx, name) 再注册扩展，
  // 用最小 Service 基类承接，直接 new 出实例即可捕获 prepare（不必走 ctx.plugin）。
  'class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name; } }',
].join('\n');

src = src
  .replace(/^import z from "@deepseek-ai\/schemastery";$/m, '')
  .replace(/^import \{ Service \} from "@deepseek-ai\/cordis";$/m, '')
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
/**
 * 实际走的是哪条链路：`service` = 0.2.2-rc.1 起的 Cordis Service，
 * `apply` = 更早的 apply() 直连。核心再改名时，回落路径会在无人察觉的情况下换链路，
 * 所以把它打进摘要——「测的是不是你以为在测的东西」得是事实，不是记忆。
 */
let branch = 'none';
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
  // 0.2.2-rc.1 起 apply() 只做 ctx.plugin(Service)；这里直接构造实例，效果相同。
  if (typeof core.SessionLogDeepSeekService === 'function') {
    branch = 'service';
    prepare = null;
    new core.SessionLogDeepSeekService(ctx, { enabled: { get: () => true }, maxBytes });
  } else {
    branch = 'apply';
    core.apply(ctx, { enabled: { get: () => true }, maxBytes });
  }
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

console.log('core version        ' + (coreVersion ?? '(unknown)'));
console.log('branch              ' + branch);
console.log('sessions            ' + files.length);
console.log('comparisons         ' + compared);
console.log('core errors         ' + coreThrew);
console.log('mismatches          ' + mismatched);
for (const sample of samples) console.log('---\n' + sample);
process.exit(mismatched === 0 && coreThrew === 0 ? 0 : 1);
