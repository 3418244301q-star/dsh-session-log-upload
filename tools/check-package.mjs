/**
 * 打包完整性守卫：`package.json` 的 `files` 漏了新加的对外产物，是种不会报错的失效。
 *
 * 起因（F16）：1.1.5 加了 `assets/icon-180.png` 当市场卡片图标，`files` 却没带 `assets/`。
 * 仓库里有、包里没有——而市场取图的两条路径里，npm CDN 那条正是从包里取的。
 *
 * 这里跑 `npm pack --dry-run --json`（不落盘、不联网），核三件事：
 *   1. 必须随包发布的文件都在；
 *   2. 至少有一个 `assets/*.png`；
 *   3. 内部文件（AGENTS.md / AUDIT*.md）没有混进来。
 *
 * 用法：node tools/check-package.mjs
 * 退出码：0 通过 / 1 有缺漏 / 2 跑不起来（npm 缺失）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** 必须出现在 tarball 里的文件（相对包根）。加一个对外产物，这里跟着加。 */
const REQUIRED = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
];

/** 内部文件，绝不能进包。 */
const FORBIDDEN = /^(AGENTS\.md|AUDIT.*\.md)$/i;

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: true,
  timeout: 60000,
});

if (result.status !== 0) {
  console.error(`PACKAGE-NOT-RUN: npm pack --dry-run 失败（exit ${String(result.status)}）`);
  console.error(String(result.stderr ?? '').trim().split('\n').slice(-3).join('\n'));
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('PACKAGE-NOT-RUN: 解析不了 npm pack 的 JSON 输出');
  process.exit(2);
}

const files = (report[0]?.files ?? []).map((entry) => entry.path);
const set = new Set(files);
const problems = [];

for (const required of REQUIRED) {
  if (!set.has(required)) problems.push(`缺少 ${required}`);
}

const pngs = files.filter((file) => file.startsWith('assets/') && file.endsWith('.png'));
if (pngs.length === 0) problems.push('assets/ 下一个 .png 都没有（市场图标就在那里）');

for (const file of files) {
  if (FORBIDDEN.test(path.basename(file))) problems.push(`内部文件进了包：${file}`);
}

/* 版本号也从包内容里核一次：读的是 tarball 里那份 package.json，不是工作副本。 */
const packed = report[0]?.version;
const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (packed !== local) problems.push(`包内版本 ${String(packed)} != 工作副本 ${String(local)}`);

const checks = REQUIRED.length + 2 + 1;

if (problems.length > 0) {
  console.error(`FAIL  打包内容有缺漏（${problems.length} 处）`);
  for (const problem of problems) console.error(`      ${problem}`);
  console.error('      对照 package.json 的 files / exports；漏了对外产物就补上，别只留在仓库里。');
  console.error(`package           ${checks - problems.length}/${checks} passed`);
  process.exit(1);
}

console.log(`文件              ${files.length} 个（含 ${pngs.length} 张 png：${pngs.map((p) => path.basename(p)).join(' ')}）`);
console.log(`package           ${checks}/${checks} passed`);
process.exit(0);
