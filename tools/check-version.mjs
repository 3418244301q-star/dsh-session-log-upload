/**
 * 版本一致性守卫：package.json、CHANGELOG、git 标签三处不能各说各话。
 *
 *   node tools/check-version.mjs
 *
 * 只查「能被改错的地方」，不要求每个提交都打标签——开发中的提交本来就不该有。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const results = [];
const check = (label, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '');
check('package.json carries a plain semver version', /^\d+\.\d+\.\d+$/.test(version), version);

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const header = changelog.match(/^\*\*当前版本\*\*：(.+)$/m)?.[1]?.trim() ?? '';
check('CHANGELOG header agrees with package.json', header === version, header || '(missing)');

check('CHANGELOG has a section for this version', changelog.includes(`## ${version} — `), `## ${version} — …`);

const tableVersions = [...changelog.matchAll(/^\|\s*\*{0,2}(\d+\.\d+\.\d+)\*{0,2}\s*\|/gm)].map((m) => m[1]);
const newest = tableVersions[tableVersions.length - 1];
check('the version table ends at this version', newest === version, `${newest} vs ${version}`);

/* git 标签：HEAD 上若有 v* 标签，必须正好是本版 */
let tags = [];
try {
  tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
} catch {
  tags = [];
}
check('HEAD carries this version tag (when tagged at all)', tags.every((tag) => tag === `v${version}`), tags.join(',') || 'untagged');

const failures = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
