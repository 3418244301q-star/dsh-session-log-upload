/**
 * 会话日志线格式（wire format）构造器 —— 与核心包
 * @deepseek-ai/dsh-session-log-deepseek 的 lib/index.js 保持等价。
 *
 * 这里只做"把磁盘上的 session.v*.jsonl 事件翻译成请求顶层字段 dsh_session_log
 * 所需的结构"，不含任何网络与状态逻辑，插件和脚本都可直接复用。
 */

/** 每个请求携带的字段上限，与内置插件的 maxBytes 默认值一致（8 MiB）。 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 内置插件写入会话日志的接受水位事件类型。 */
export const ACCEPTANCE_EVENT = 'session-log-deepseek/delivery-accepted';

/** 官方 DeepSeek 适配器的 provider id（request/header 事件里出现）。 */
export const OFFICIAL_PROVIDER = 'deepseek-official';

/**
 * 会话 header → 请求字段 session。
 * 只有在磁盘上真实存在的可选字段才透传，避免把 undefined 序列化进去。
 */
export function wireHeader(header, inheritedEventCount) {
  const out = {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
  };
  if (header.cwd !== undefined) out.cwd = header.cwd;
  if (header.parentSession !== undefined) out.parentSession = String(header.parentSession);
  if (header.isSeeded) out.seedLength = Number(inheritedEventCount);
  if (header.origin !== undefined) out.origin = header.origin;
  if (header.delegationDepth !== undefined) out.delegationDepth = header.delegationDepth;
  if (header.agentPreset !== undefined) out.agentPreset = header.agentPreset;
  return out;
}

/** surfaceOp 只有 append 是字符串，替换展开成 {op,startSeq,endSeq} 的数值对象。 */
function wireSurfaceOp(op) {
  if (op === 'append') return op;
  return { op: 'replace', startSeq: Number(op.startSeq), endSeq: Number(op.endSeq) };
}

/**
 * 单条事件 → 请求字段里的事件 envelope。
 * 注意键顺序：common 在前，type/surfaceOp 在后——和核心保持同一序列化顺序，
 * 这样字节预算的估算与内置插件一致。
 */
export function wireEvent(event) {
  const common = {
    seq: Number(event.seq),
    time: event.time,
    data: event.data,
  };
  if (event.ignorable !== undefined) common.ignorable = event.ignorable;

  switch (event.type) {
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'tool/result': {
      const out = { ...common, type: event.type, surfaceOp: wireSurfaceOp(event.surfaceOp) };
      if (event.sourceEventSeqs !== undefined) out.sourceEventSeqs = event.sourceEventSeqs.map(Number);
      return out;
    }
    case 'assistant/message':
      return { ...common, type: event.type, surfaceOp: wireSurfaceOp(event.surfaceOp) };
    default:
      // 未知类型 + ignorable：核心会把插件的自定义 surfaceOp 原样透传（不展开成对象）。
      // 核心用 KNOWN_SESSION_EVENT_TYPES 判断"已知类型"，这里以 ignorable 作为近似，
      // 差异只影响插件自定义事件，不影响标准会话事件。
      if (event.ignorable === true) {
        const out = { ...common, type: event.type };
        if (event.surfaceOp !== undefined) out.surfaceOp = event.surfaceOp;
        if (event.sourceEventSeqs !== undefined) out.sourceEventSeqs = event.sourceEventSeqs.map(Number);
        return out;
      }
      return { ...common, type: event.type };
  }
}

/** UTF-8 字节数；无法序列化时返回 Infinity（等同于超过任何上限）。 */
export function jsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Infinity : Buffer.byteLength(text, 'utf8');
  } catch {
    return Infinity;
  }
}

/**
 * 从已接受水位之后切出最长连续事件段，使其序列化后不超过 maxBytes。
 *
 * 算法与内置插件一致：先算"空事件信封"的字节数（减掉 throughSeq 的 1 位数字），
 * 再逐条累加事件字节、逗号与最终 seq 的位数。
 *
 * @returns {{envelope: object|null, bytes: number, blockedSeq: number|null}}
 */
export function segmentEnvelope({ header, inheritedEventCount, events, afterSeq, maxBytes = DEFAULT_MAX_BYTES }) {
  const session = wireHeader(header, inheritedEventCount);
  const envelope = {
    version: 1,
    sessionFormatVersion: header.version,
    session,
    afterSeq: Number(afterSeq),
  };

  let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1;
  const chosen = [];
  let blockedSeq = null;

  for (const event of events) {
    let wire;
    try {
      wire = wireEvent(event);
    } catch {
      blockedSeq = Number(event.seq);
      break;
    }
    const next = bytes + (chosen.length === 0 ? 0 : 1) + jsonBytes(wire);
    const candidate = next + String(event.seq).length;
    if (candidate > maxBytes) {
      blockedSeq = Number(event.seq);
      break;
    }
    bytes = next;
    chosen.push(wire);
  }

  if (chosen.length === 0) {
    return { envelope: null, bytes: 0, blockedSeq: blockedSeq ?? (events[0] ? Number(events[0].seq) : null) };
  }

  const throughSeq = chosen[chosen.length - 1].seq;
  const full = { ...envelope, throughSeq, events: chosen };
  const actual = jsonBytes(full);
  if (actual > maxBytes) {
    // 记账法与真实序列化出现偏差时，宁可少传也不超限：回退到最后一个确定安全的段。
    return { envelope: null, bytes: 0, blockedSeq: throughSeq, overBudget: actual };
  }
  return { envelope: full, bytes: actual, blockedSeq: null };
}
