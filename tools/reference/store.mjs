/**
 * 会话日志的读取与水位计算。只读，不写任何文件。
 *
 * 磁盘布局（本机实测）：
 *   ~/.dsh/sessions/<编码后的 cwd 目录>/<会话目录>/session.v4.jsonl.zstd
 * 首行是 header（没有 seq/time），之后每行一条事件（有 seq/time）。
 * 文件是 zstd 压缩的 JSONL，Node 22+ 的 zlib.zstdDecompressSync 可直接解。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { ACCEPTANCE_EVENT, OFFICIAL_PROVIDER } from './envelope.mjs';

/** 默认的 DSH 主目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 递归找出所有会话日志文件。 */
export function listSessionFiles(root = path.join(dshHome(), 'sessions')) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
    }
  }
  return out;
}

/** 解压并逐行解析，返回 {header, events, rawLines}。坏行跳过并计数。 */
export function readSession(file) {
  const buf = fs.readFileSync(file);
  const text = file.endsWith('.zstd') || buf[0] === 0x28
    ? zlib.zstdDecompressSync(buf).toString('utf8')
    : buf.toString('utf8');

  const lines = text.split('\n').filter((line) => line.trim() !== '');
  let header = null;
  const events = [];
  let badLines = 0;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!header && obj.type === 'session' && obj.id !== undefined) {
      header = obj;
      continue;
    }
    if (typeof obj.seq === 'number') events.push(obj);
  }

  if (!header) throw new Error(`不是有效的会话日志（找不到首行 header）: ${file}`);
  events.sort((a, b) => a.seq - b.seq);
  return { header, events, badLines, file };
}

/**
 * 已接受水位：扫描 delivery-accepted 事件，只认 sessionId 与格式代都匹配的，
 * 取最大 throughSeq。fork 会话会继承父会话的接受记录，这些必须被忽略。
 */
export function acceptedThrough(header, events) {
  let through = -1;
  for (const event of events) {
    if (event.type !== ACCEPTANCE_EVENT) continue;
    const data = event.data ?? {};
    const format = data.sessionFormatVersion ?? 0;
    if (format !== header.version) continue;
    if (typeof data.sessionId !== 'string' || data.sessionId !== header.id) continue;
    if (typeof data.throughSeq !== 'number') continue;
    if (data.throughSeq > through) through = data.throughSeq;
  }
  return through;
}

/** seeded 会话的 seedLength = 从父会话继承的事件数（session/end-seed 的 seq + 1）。 */
export function inheritedEventCount(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'session/end-seed') return Number(events[i].seq) + 1;
  }
  return 0;
}

/** 水位之后、尚未上传的事件。 */
export function pendingEvents(events, afterSeq) {
  return events.filter((event) => Number(event.seq) > afterSeq);
}

/**
 * 待传区间里出现过哪些 provider。
 * request/header 事件带有 header.config.provider 与 model，用它判断这一段有没有走官方适配器。
 */
export function providersInRange(events, afterSeq) {
  const seen = new Map();
  for (const event of events) {
    if (Number(event.seq) <= afterSeq) continue;
    if (event.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (!config?.provider) continue;
    const key = `${config.provider}/${config.model ?? '?'}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].map(([route, count]) => ({
    route,
    count,
    official: route.startsWith(`${OFFICIAL_PROVIDER}/`),
  }));
}

/** 汇总一个会话的可读状态，供 list/inspect 使用。 */
export function describeSession(file) {
  const { header, events, badLines } = readSession(file);
  const afterSeq = acceptedThrough(header, events);
  const pending = pendingEvents(events, afterSeq);
  const routes = providersInRange(events, afterSeq);
  return {
    file,
    id: header.id,
    version: header.version,
    createdAt: header.createdAt,
    cwd: header.cwd,
    isSeeded: Boolean(header.isSeeded),
    parentSession: header.parentSession,
    origin: header.origin,
    events: events.length,
    acceptedThrough: afterSeq,
    pending: pending.length,
    nextSeq: pending.length ? Number(pending[0].seq) : null,
    lastSeq: events.length ? Number(events[events.length - 1].seq) : null,
    routes,
    badLines,
  };
}
