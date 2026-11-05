/**
 * 对照验证：插件里的分段逻辑 vs D:\dsh\3\lib\envelope.mjs（已验证过的参考实现）。
 * 用真实会话日志跑，比较字节数与 throughSeq 是否完全一致。
 *
 *   node tools/check-envelope.mjs            # 扫所有会话
 *   node tools/check-envelope.mjs <关键词>   # 只测匹配的会话
 */
import { readSession, listSessionFiles, dshHome, acceptedThrough as refAccepted, pendingEvents, inheritedEventCount } from './reference/store.mjs';
import { segmentEnvelope } from './reference/envelope.mjs';
import path from 'node:path';
import { __internals } from '../index.js';

const needle = process.argv[2]?.toLowerCase();
const files = listSessionFiles().filter((f) => !needle || f.toLowerCase().includes(needle));

/** 把磁盘日志包成 session 形状，模拟 Host 里的 Session 对象。 */
function fakeSession(header, events) {
  const count = events.length;
  return {
    header,
    inheritedEventCount: inheritedEventCount(events),
    id: header.id,
    seq: count,
    eventAt: (seq) => events[seq],
    snapshotEvents: (from = 0) => events.filter((e) => Number(e.seq) >= Number(from)),
    appended: [],
    append(type, data) {
      this.appended.push({ type, data });
    },
  };
}

let checked = 0;
let mismatched = 0;

for (const file of files) {
  let parsed;
  try {
    parsed = readSession(file);
  } catch {
    continue;
  }
  const { header, events } = parsed;
  const session = fakeSession(header, events);
  const after = refAccepted(header, events);

  const reference = segmentEnvelope({
    header,
    inheritedEventCount: session.inheritedEventCount,
    events: pendingEvents(events, after),
    afterSeq: after,
  });
  const mine = __internals.segment(session, after, 8 * 1024 * 1024);

  // 水位折叠也要一致
  const myAfter = __internals.acceptedThrough(session);

  checked += 1;
  const problems = [];
  if (myAfter !== after) problems.push(`watermark ${myAfter} != ${after}`);
  if (Boolean(reference.envelope) !== Boolean(mine.envelope)) {
    problems.push(`null-ness differs (ref ${reference.envelope ? 'segment' : 'null'} / mine ${mine.envelope ? 'segment' : 'null'})`);
  } else if (reference.envelope) {
    if (reference.envelope.throughSeq !== mine.envelope.throughSeq) {
      problems.push(`throughSeq ${mine.envelope.throughSeq} != ${reference.envelope.throughSeq}`);
    }
    if (reference.bytes !== mine.bytes) problems.push(`bytes ${mine.bytes} != ${reference.bytes}`);
    if (reference.envelope.events.length !== mine.envelope.events.length) {
      problems.push(`events ${mine.envelope.events.length} != ${reference.envelope.events.length}`);
    }
    if (JSON.stringify(reference.envelope) !== JSON.stringify(mine.envelope)) problems.push('payload JSON differs');
  }

  if (problems.length > 0) {
    mismatched += 1;
    console.log(`FAIL ${file}`);
    for (const p of problems) console.log(`     ${p}`);
  }
}

/*
 * 空语料不能判绿：listSessionFiles() 会吞掉 readdir 的错误，读不到 ~/.dsh 时它返回空数组，
 * 于是一个「什么都没查」的运行看起来和「全部一致」一模一样。这里把它变成显式失败。
 */
if (checked === 0) {
  const root = path.join(dshHome(), 'sessions');
  console.log('');
  console.log(`ENVELOPE-NOT-RUN: 0 会话，本次运行不构成验证（${files.length === 0 ? `${root} 下没有可读的会话日志` : `${files.length} 个日志文件全部读取失败`}）`);
  console.log('检查 DSH_HOME，或者确认传给脚本的关键词没有把语料筛空。');
  process.exit(2);
}

console.log(`\nchecked ${checked} session(s), ${mismatched} mismatch(es)`);
process.exit(mismatched === 0 ? 0 : 1);
