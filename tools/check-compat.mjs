/**
 * 兼容性守卫：拿**装机的**核心，核两件会静默失效的事。
 *
 * 1. `engines.dsh` 是否真的匹配装机核心版本（F14）
 *    预发布版本的 semver 规则是：范围里必须存在「major.minor.patch 完全相同且自身带预发布
 *    标签」的比较符，否则预发布版本一律不算匹配。核心每进一个 minor 预发布，范围就要人肉补
 *    一个 tuple；漏了不报错、不告警，只会从市场的兼容筛选里静默消失。
 *    这里用真 semver（不是自己写一个近似实现——那正是这个 bug 的来源）对着装机版本算一次。
 *
 * 2. 客户端契约串是否还在，以及它们各自落在**哪个包**（F15）
 *    `settings.general.item` / `configForms` 不在 `dsh-web-frontend` 的 shell bundle 里，
 *    而在运行时分发的客户端插件包里。只扫 shell 会得到假阴性。所以这里打印归属包。
 *
 * 用法：node tools/check-compat.mjs
 *      DSH_ASAR=<path>      指定其他安装位置
 *      DSH_PROFILE_DIR=...  指定 profile 目录（找 semver 用）
 *      DSH_SEMVER=<path>    直接指定 semver 包目录
 *
 * 退出码：0 通过 / 1 不兼容 / 2 没跑成（找不到 asar 或 semver —— 不能静默当绿）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openAsar } from './asar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** 契约串：本插件依赖的宿主/客户端接口。加一项，表里的数字跟着变。 */
const CONTRACTS = [
  { needle: 'settings.general.item', why: '设置页插槽（客户端插件包，不在 shell bundle）' },
  { needle: 'configForms', why: '设置行的读写服务' },
  { needle: 'RiskConfirmation', why: '风险确认弹窗（官方原语）' },
  { needle: 'dsh-client-ui-primitives', why: '上面那个原语的静态模块名' },
  { needle: '__ModuleLoader__', why: '客户端插件加载入口' },
  { needle: 'dsh_session_log', why: '线格式的顶层字段名' },
  { needle: 'deepseekLlmApiExtensions', why: '内置上传器挂载的扩展点' },
  { needle: 'session-log-deepseek/delivery-accepted', why: '与内置共用的水位事件' },
];

/** 找真的 semver：先看本地依赖，再顺着 DSH profile 找。找不到就红，不自己实现。 */
function loadSemver() {
  const requireHere = createRequire(path.join(ROOT, 'package.json'));
  try {
    return requireHere('semver');
  } catch {
    /* 本地没有，往下走 */
  }
  const profileDir = process.env.DSH_PROFILE_DIR
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop');
  const candidates = [process.env.DSH_SEMVER, path.join(profileDir, 'node_modules', 'semver')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return createRequire(path.join(candidate, 'package.json'))('semver');
    } catch {
      try {
        return createRequire(path.join(candidate, 'noop.js'))(candidate);
      } catch {
        /* 下一个 */
      }
    }
  }
  try {
    return createRequire(path.join(profileDir, 'package.json'))('semver');
  } catch {
    return null;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const range = pkg.dsh?.engines?.dsh;
if (typeof range !== 'string') {
  console.error('package.json 里没有 dsh.engines.dsh');
  process.exit(1);
}

let asar;
try {
  asar = openAsar();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}

const CORE_PKG = 'dsh/node_modules/@deepseek-ai/dsh/package.json';
const coreVersion = asar.version(CORE_PKG);
if (coreVersion === null) {
  console.error(`读不到装机核心版本：${CORE_PKG}`);
  process.exit(2);
}

const semver = loadSemver();
if (semver === null) {
  console.error('ENGINES-NOT-RUN: 找不到 semver（本地依赖与 DSH profile 都没有）。');
  console.error('用 DSH_SEMVER=<semver 包目录> 指定，或 npm i -D semver。不能靠手写近似实现——那正是本检查要防的 bug。');
  process.exit(2);
}

let bad = 0;
let checks_declared = false;

/* ── 1. engines.dsh 对装机核心 ── */
const matches = semver.satisfies(coreVersion, range, { includePrerelease: false });
if (!matches) {
  bad += 1;
  console.error(`FAIL  engines.dsh 不匹配装机核心 ${coreVersion}`);
  console.error(`      当前范围: ${range}`);
  const parsed = semver.parse(coreVersion);
  const tuple = parsed === null ? coreVersion : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const next = parsed === null ? 'X.Y.Z' : `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  console.error(`      修: 给 ${tuple} 这个 tuple 补一个预发布比较符，例如`);
  console.error(`          ">=0.2.1-rc.3 <${next}-0 || >=${tuple}-rc.1"`);
  console.error(`      并顺手把 README「预发布版本的 semver 盲区」表的当前行改对。`);
}

/* ── 1b. 记录在案的核心版本必须等于装机核心（Release 标题就写它） ── */
const declared = pkg.dsh?.verifiedCoreVersion;
if (typeof declared !== 'string' || declared.length === 0) {
  bad += 1;
  console.error('FAIL  package.json 缺 dsh.verifiedCoreVersion');
  console.error('      这个字段同时决定 Release 标题里的「验证过的核心版本」，不能靠记忆。');
} else if (declared !== coreVersion) {
  bad += 1;
  console.error(`FAIL  dsh.verifiedCoreVersion=${declared} 与装机核心 ${coreVersion} 不一致`);
  console.error('      核心升级后要重跑套件，然后把这两处一起改：package.json 的这个字段、README「本机实测」。');
} else {
  checks_declared = true;
}

/* ── 2. 契约串 ── */
const missing = [];
const owners = [];
for (const contract of CONTRACTS) {
  const hits = asar.find(contract.needle);
  if (hits.length === 0) {
    missing.push(contract);
    continue;
  }
  // 只报「几个包 + 前三个」，全量列表会长到没法看，而且归属本身才是重点。
  const ranked = hits
    .map((group) => `${group.package}(${group.files.reduce((sum, file) => sum + file.count, 0)})`)
    .sort((a, b) => Number(b.split('(')[1].slice(0, -1)) - Number(a.split('(')[1].slice(0, -1)));
  const where = hits.length <= 3 ? ranked.join(' ') : `${ranked.slice(0, 3).join(' ')} … 共 ${hits.length} 个包`;
  owners.push({ needle: contract.needle, where });
}
asar.close();

const contractsOk = CONTRACTS.length - missing.length;
if (missing.length > 0) {
  bad += 1;
  console.error(`FAIL  契约串缺失 ${missing.length}/${CONTRACTS.length}`);
  for (const contract of missing) console.error(`      ${contract.needle} — ${contract.why}`);
} else {
  console.log(`契约串            ${contractsOk}/${CONTRACTS.length} 全在`);
  for (const owner of owners) console.log(`    ${owner.needle.padEnd(40)} ${owner.where}`);
}

console.log(`engines           ${coreVersion} ${matches ? '匹配' : '不匹配'} ${range}`);
console.log(`core version      声明 ${declared ?? '(缺失)'} · 装机 ${coreVersion} ${checks_declared ? '一致' : '不一致'}`);
console.log(`compat            ${contractsOk + (matches ? 1 : 0) + (checks_declared ? 1 : 0)}/${CONTRACTS.length + 2} passed`);
process.exit(bad === 0 ? 0 : 1);
