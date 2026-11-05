/**
 * 文档数字守卫：跑一遍测试套件，把实测结果和 CHANGELOG「验证工具一览」那张表比对。
 *
 * 这张表已经腐化过两次（0.5.2、0.5.5 都是加了测试却忘改总表），所以让机器来盯：
 * 数字对不上就退出码 1。
 *
 *   node tools/check-docs.mjs            # 跑套件并比对
 *   node tools/check-docs.mjs --no-run   # 只比对，用表里现有的数字（对照最近一次结果）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

/** 每个套件：怎么跑、从输出里抠哪几个数字、表里对应哪一行。 */
const SUITES = [
  {
    name: 'check-core-parity.mjs',
    row: /check-core-parity\.mjs/,
    parse: (out) => {
      const sessions = Number(out.match(/sessions\s+(\d+)/)?.[1] ?? NaN);
      const comparisons = Number(out.match(/comparisons\s+(\d+)/)?.[1] ?? NaN);
      const mismatches = Number(out.match(/mismatches\s+(\d+)/)?.[1] ?? NaN);
      return { sessions, comparisons, mismatches };
    },
    expect: (row, actual) => {
      const m = row.match(/(\d+)\s*会话\s*×\s*(\d+)\s*档\s*=\s*(\d+)\/(\d+)/);
      if (!m) return ['cannot parse the parity row'];
      const problems = [];
      // 会话数随本机日志变化，不做硬比对；只校验表内自洽与"差异必须为 0"。
      if (Number(m[1]) * Number(m[2]) !== Number(m[3])) {
        problems.push(`row is not self-consistent: ${m[1]} x ${m[2]} != ${m[3]}`);
      }
      if (Number(m[3]) !== Number(m[4])) problems.push(`passed/total mismatch in row: ${m[3]}/${m[4]}`);
      if (actual.mismatches !== 0) problems.push(`mismatches ${actual.mismatches} != 0`);
      return problems;
    },
  },
  {
    name: 'check-runtime.mjs',
    row: /check-runtime\.mjs/,
    parse: (out) => Number(out.match(/(\d+)\/\d+ passed/)?.[1] ?? NaN),
    expect: (row, actual) => {
      const m = row.match(/\*\*(\d+)\/\d+\*\*/);
      if (!m) return ['cannot parse the runtime row'];
      return Number(m[1]) === actual ? [] : [`runtime ${m[1]} != ${actual}`];
    },
  },
  {
    name: 'check-client.mjs',
    row: /check-client\.mjs/,
    parse: (out) => Number(out.match(/(\d+)\/\d+ passed/)?.[1] ?? NaN),
    expect: (row, actual) => {
      const m = row.match(/\*\*(\d+)\/\d+\*\*/);
      if (!m) return ['cannot parse the client row'];
      return Number(m[1]) === actual ? [] : [`client ${m[1]} != ${actual}`];
    },
  },
  {
    name: 'check-version.mjs',
    row: /check-version\.mjs/,
    parse: (out) => Number(out.match(/(\d+)\/\d+ passed/)?.[1] ?? NaN),
    expect: (row, actual) => {
      const m = row.match(/\*\*(\d+)\/\d+\*\*/);
      if (!m) return ['cannot parse the version row'];
      return Number(m[1]) === actual ? [] : [`version ${m[1]} != ${actual}`];
    },
  },
  {
    name: 'check-envelope.mjs',
    row: /check-envelope\.mjs/,
    parse: (out) => {
      const sessions = Number(out.match(/checked (\d+) session/)?.[1] ?? NaN);
      const mismatches = Number(out.match(/(\d+) mismatch/)?.[1] ?? NaN);
      return { sessions, mismatches };
    },
    expect: (row, actual) => {
      if (!/(\d+) 会话/.test(row)) return ['cannot parse the envelope row'];
      return actual.mismatches !== 0 ? [`envelope mismatches ${actual.mismatches} != 0`] : [];
    },
  },
];

const noRun = process.argv.includes('--no-run');
const text = fs.readFileSync(CHANGELOG, 'utf8');
const tableStart = text.indexOf('## 验证工具一览');
if (tableStart < 0) {
  console.error('CHANGELOG 里找不到「验证工具一览」段落');
  process.exit(2);
}
const table = text.slice(tableStart, text.indexOf('\n## ', tableStart + 10) > 0
  ? text.indexOf('\n## ', tableStart + 10)
  : text.length);

let bad = 0;
for (const suite of SUITES) {
  const row = table.split('\n').find((line) => suite.row.test(line) && line.includes('|'));
  if (row === undefined) {
    console.error(`FAIL  CHANGELOG 表里没有 ${suite.name} 这一行`);
    bad += 1;
    continue;
  }
  if (noRun) {
    console.log(`SKIP  ${suite.name}（--no-run）`);
    continue;
  }
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(HERE, suite.name)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    console.error(`FAIL  ${suite.name} 自己没跑过\n${out.split('\n').slice(-3).join('\n')}`);
    bad += 1;
    continue;
  }

  const actual = suite.parse(out);
  const problems = [].concat(suite.expect(row, actual));
  if (problems.length === 0) {
    console.log(`PASS  ${suite.name}  ${typeof actual === 'object' ? JSON.stringify(actual) : actual}`);
  } else {
    bad += 1;
    console.error(`FAIL  ${suite.name}  ${problems.join('; ')}`);
    console.error(`      CHANGELOG 行: ${row.trim()}`);
  }
}

if (noRun && bad === 0) {
  console.log('\n文档结构完好（未运行套件）');
} else {
  console.log(bad === 0 ? '\n文档数字与实测一致' : `\n${bad} 处不一致：先改 CHANGELOG 的「验证工具一览」`);
}
process.exit(bad === 0 ? 0 : 1);
