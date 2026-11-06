/**
 * 从 CHANGELOG 抽出当前版本的段落，作为 GitHub Release 正文。
 *
 * 为什么要脚本：Release 正文原先靠人从 CHANGELOG 复制。手动的后果不是慢，是**不同源**——
 * CHANGELOG 改了、Release 忘同步，两边说法不一致，而且没人会发现。
 *
 * 前提由 `check-version.mjs` 保证：包版本 = CHANGELOG 抬头 = CHANGELOG 里有这个版本的段落。
 * 所以这里不在找不到段落时「降级成空正文」，而是直接失败。
 *
 * 用法：
 *   node tools/release-notes.mjs            # 打印到 stdout
 *   node tools/release-notes.mjs > notes.md
 *   node tools/release-notes.mjs --title    # 只打印 Release 标题
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
/** 验证过的 DSH 核心版本：标题里要写它，由 check-compat 对着装机核心核。 */
const core = pkg.dsh?.verifiedCoreVersion;

if (typeof version !== 'string' || version.length === 0) {
  console.error('package.json 没有 version');
  process.exit(1);
}
if (typeof core !== 'string' || core.length === 0) {
  console.error('package.json 缺 dsh.verifiedCoreVersion——Release 标题要写验证过的核心版本');
  process.exit(1);
}

if (process.argv.includes('--title')) {
  process.stdout.write(`dsh-session-log-upload ${version} · DSH ${core}\n`);
  process.exit(0);
}

const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const head = `## ${version} — `;
const start = text.indexOf(head);
if (start < 0) {
  console.error(`CHANGELOG.md 里找不到「${head}…」这一段`);
  process.exit(1);
}

const afterHead = text.indexOf('\n', start);
const nextHeading = text.indexOf('\n## ', afterHead);
const body = text.slice(afterHead, nextHeading < 0 ? undefined : nextHeading).trim();

if (body.length === 0) {
  console.error(`CHANGELOG.md 里 ${version} 那一段是空的`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
