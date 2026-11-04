/**
 * dsh-session-log-upload — 跨渠道会话日志上传（Host 插件）。
 *
 * 内置插件 @deepseek-ai/dsh-session-log-deepseek 只搭官方适配器的便车：它把
 * `dsh_session_log` 挂到 chat 请求上。第三方渠道（ollama-local / pi-ai / OpenAI
 * 兼容）不走那条适配器，日志就永远上不去。本插件自己发一次最小 chat 请求，
 * 把同一个顶层字段送到 api.deepseek.com，并且**用内置插件同一套水位事件**
 * （session-log-deepseek/delivery-accepted）落盘，两条路径不会互相重复。
 *
 * 协议契约见 D:\dsh\3\SPEC-跨渠道会话日志上传.md §3；线格式与字节记账法
 * 与 D:\dsh\3\lib\envelope.mjs、以及核心包 lib/index.js 保持一致。
 *
 * 设计上的取舍：
 * - 声明 Config（schemastery），`enabled` 与 `mode` 标 volatile：设置页改完立即生效。
 *   注意 volatile 字段在运行时是 accessor（`.get()`），readConfig 两种形态都读。
 * - 除 schemastery 外不 import 任何 @deepseek-ai/*：会话 API 的 branded 类型
 *   编译期才有意义，运行时就是普通 number/string。
 */

import z from '@deepseek-ai/schemastery';

export const name = 'dsh-session-log-upload';

/**
 * 配置 schema。`enabled` 与 `mode` 是 volatile：设置页改完立即生效，不用重启。
 * volatile 字段在运行时是 accessor（`.get()`），普通字段是裸值，readConfig 两种都认。
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  mode: z.union(['manual', 'deferred', 'realtime']).default('deferred').volatile(),
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY'),
  model: z.string().default('deepseek-flash'),
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
  idleDelayMs: z.number().step(1).min(0).default(600000),
  includeSeeded: z.boolean().default(false),
  concurrency: z.number().step(1).min(1).default(1),
  budget: z.object({
    maxRequestsPerHour: z.number().step(1).min(1).default(60),
  }).default({ maxRequestsPerHour: 60 }),
  retry: z.object({
    maxAttempts: z.number().step(1).min(1).default(3),
    baseDelayMs: z.number().step(1).min(0).default(2000),
  }).default({ maxAttempts: 3, baseDelayMs: 2000 }),
});

/** 离线验证用：把纯函数暴露给对照脚本，不影响运行路径。 */
export const __internals = {};

/** 需要 sessions 找会话、credentials 取 key。 */
export const inject = ['sessions', 'credentials'];

/** 内置插件写的水位事件类型，必须与核心包逐字一致。 */
const ACCEPTANCE_EVENT = 'session-log-deepseek/delivery-accepted';

/** 官方适配器 provider id：这一段全是它，就交给内置插件，本插件不插手。 */
const OFFICIAL_PROVIDER = 'deepseek-official';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * 核心 KNOWN_SESSION_EVENT_TYPES 的本地副本（对照 @deepseek-ai/dsh-session 0.2.1-rc.5）。
 * 只有**未知类型** + ignorable 才透传 surfaceOp/sourceEventSeqs，已知类型一律不带。
 *
 * 已知偏差：核心有 59 条，这里只列常见的 17 条。对本机全部会话实测：ignorable 事件
 * 2423 条全部是插件自定义类型（oh-my-dsh/*、plugin:translator/* 等），没有一条命中本表，
 * 因此当前不产生字节分叉。核心新增事件类型时需要同步本表。
 */
const KNOWN_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'developer/message', 'system/message', 'assistant/message',
  'assistant/attempt', 'tool/call', 'tool/result',
  'request/header', 'request/context',
  'session/end-seed', 'session/start', 'session/end', 'session/archive',
]);

/** 单次运行最多连续发几段，防止一个超大历史会话把限流配额一次打光。 */
const MAX_SEGMENTS_PER_RUN = 8;

/** 连续失败超过这个次数就不再自动重排（等下一次 turn/end 或手动点击）。 */
const MAX_AUTO_RETRY_STREAK = 3;

/**
 * 一次触发里最多自动续几轮（每轮 MAX_SEGMENTS_PER_RUN 段）。
 * 必须有上限：每传一段都会追加一条 delivery-accepted，传完真实内容后它自己会成为
 * 下一轮的待传事件，没有上限就会一直转下去。
 */
const MAX_DRAIN_ROUNDS = 4;

const DEFAULTS = {
  enabled: false,
  mode: 'deferred',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  model: 'deepseek-flash',
  maxBytes: 8 * 1024 * 1024,
  idleDelayMs: 600000,
  includeSeeded: false,
  maxRequestsPerHour: 60,
  maxAttempts: 3,
  baseDelayMs: 2000,
  concurrency: 1,
};

/** volatile 字段是 accessor，普通字段是裸值；两种都读成裸值。 */
function pick(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const inner = value.get();
      return inner === undefined ? fallback : inner;
    } catch {
      return fallback;
    }
  }
  return value === undefined ? fallback : value;
}

/** 数字字段：NaN / 非数字一律回落到默认值，避免 maxBytes=NaN 让上限整体失效。 */
function num(value, fallback) {
  const parsed = Number(pick(value, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 读一次 config，每次触发都重读：设置页改完（volatile）下一次触发就是新值。 */
function readConfig(raw) {
  const cfg = raw ?? {};
  const budget = cfg.budget ?? {};
  const retry = cfg.retry ?? {};
  return {
    enabled: Boolean(pick(cfg.enabled, DEFAULTS.enabled)),
    mode: String(pick(cfg.mode, DEFAULTS.mode)),
    apiKeyRef: String(pick(cfg.apiKeyRef, DEFAULTS.apiKeyRef)),
    model: String(pick(cfg.model, DEFAULTS.model)),
    maxBytes: num(cfg.maxBytes, DEFAULTS.maxBytes),
    idleDelayMs: num(cfg.idleDelayMs, DEFAULTS.idleDelayMs),
    includeSeeded: Boolean(pick(cfg.includeSeeded, DEFAULTS.includeSeeded)),
    maxRequestsPerHour: num(budget.maxRequestsPerHour, DEFAULTS.maxRequestsPerHour),
    maxAttempts: Math.max(1, num(retry.maxAttempts, DEFAULTS.maxAttempts)),
    baseDelayMs: Math.max(0, num(retry.baseDelayMs, DEFAULTS.baseDelayMs)),
    concurrency: Math.max(1, num(cfg.concurrency, DEFAULTS.concurrency)),
  };
}

/* ────────────────────────── 线格式（与核心等价） ────────────────────────── */

function wireHeader(session) {
  const header = session.header;
  const out = {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
  };
  if (header.cwd !== undefined) out.cwd = header.cwd;
  if (header.parentSession !== undefined) out.parentSession = String(header.parentSession);
  if (header.isSeeded) {
    const seedLength = Number(session.inheritedEventCount);
    if (Number.isFinite(seedLength) && seedLength >= 0) out.seedLength = seedLength;
  }
  if (header.origin !== undefined) out.origin = header.origin;
  if (header.delegationDepth !== undefined) out.delegationDepth = header.delegationDepth;
  if (header.agentPreset !== undefined) out.agentPreset = header.agentPreset;
  return out;
}

function wireSurfaceOp(op) {
  if (op === 'append') return op;
  return { op: 'replace', startSeq: Number(op.startSeq), endSeq: Number(op.endSeq) };
}

function wireEvent(event) {
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
      // 只有"未知类型 + ignorable"才原样透传 surfaceOp / sourceEventSeqs（与核心一致）。
      if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const out = { ...common, type: event.type };
        if (event.surfaceOp !== undefined) out.surfaceOp = event.surfaceOp;
        if (event.sourceEventSeqs !== undefined) out.sourceEventSeqs = event.sourceEventSeqs.map(Number);
        return out;
      }
      return { ...common, type: event.type };
  }
}

function jsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Infinity : Buffer.byteLength(text, 'utf8');
  } catch {
    return Infinity;
  }
}

/* ────────────────────────── 会话读取与判定 ────────────────────────── */

/** 已接受水位折叠缓存：WeakMap 跟着 session 对象走，退出即回收。 */
const folds = new WeakMap();

function acceptedThrough(session) {
  const previous = folds.get(session) ?? { scanned: 0, through: -1 };
  let through = previous.through;
  const length = Number(session.seq);
  for (let index = previous.scanned; index < length; index += 1) {
    const event = session.eventAt(index);
    if (event === undefined || event.type !== ACCEPTANCE_EVENT) continue;
    const data = event.data ?? {};
    const format = data.sessionFormatVersion ?? 0;
    if (format !== session.header.version) continue;
    if (String(data.sessionId) !== String(session.id)) continue;
    if (typeof data.throughSeq !== 'number') continue;
    if (data.throughSeq > through) through = data.throughSeq;
  }
  folds.set(session, { scanned: length, through });
  return through;
}

function eventsFrom(session, fromSeq) {
  const length = Number(session.seq);
  if (fromSeq >= length) return [];
  return session.snapshotEvents(fromSeq);
}

/**
 * 水位之后还剩多少"内容"事件——排除本插件自己写的 delivery-accepted。
 * 只用于日志和"还剩多少条"的展示；发送窗口必须保持连续，不能跳着取。
 */
function countPendingContent(session, afterSeq) {
  if (afterSeq === null) return 0;
  let count = 0;
  for (const event of eventsFrom(session, afterSeq + 1)) {
    if (event.type === ACCEPTANCE_EVENT) continue;
    count += 1;
  }
  return count;
}

/**
 * 实际起始水位。
 * seeded 子会话：默认跳过；includeSeeded 时从继承段之后开始，只传它自己新增的部分，
 * 因为继承段父会话早已传过（SPEC §4.7）。
 */
function effectiveAfter(session, cfg) {
  const accepted = acceptedThrough(session);
  if (!cfg.includeSeeded && session.header.isSeeded) return null;
  if (cfg.includeSeeded && session.header.isSeeded) {
    const inherited = Number(session.inheritedEventCount);
    // inheritedEventCount 缺失时不能算出 NaN（会把整段判定吃成"无渠道"而静默跳过）
    return Number.isFinite(inherited) && inherited > 0 ? Math.max(accepted, inherited - 1) : accepted;
  }
  return accepted;
}

/**
 * 水位之前最近一条 request/header 的 provider：区间内没 header 时靠它判定渠道。
 * 水位只增不减，所以按会话缓存"已扫到哪、最后一个 provider 是谁"，避免每次都倒走全表。
 */
const carryCache = new WeakMap();

function carryProvider(session, afterSeq) {
  const last = Math.min(Number(afterSeq), Number(session.seq) - 1);
  if (!Number.isFinite(last) || last < 0) return undefined;

  let cache = carryCache.get(session);
  if (cache === undefined) {
    cache = { scanned: -1, provider: undefined };
    carryCache.set(session, cache);
  }

  // 正常情况：水位前进，只需从上次扫到的地方继续。
  if (last > cache.scanned) {
    for (let index = cache.scanned + 1; index <= last; index += 1) {
      const event = session.eventAt(index);
      if (event?.type !== 'request/header') continue;
      const provider = event.data?.header?.config?.provider;
      if (typeof provider === 'string' && provider.length > 0) cache.provider = provider;
    }
    cache.scanned = last;
    return cache.provider;
  }

  // 回退查询（少见）：缓存给不出区间内的值，直接倒扫，不污染缓存。
  for (let index = last; index >= 0; index -= 1) {
    const event = session.eventAt(index);
    if (event?.type !== 'request/header') continue;
    const provider = event.data?.header?.config?.provider;
    if (typeof provider === 'string' && provider.length > 0) return provider;
  }
  return undefined;
}

/**
 * 管着"水位之后这段事件"的渠道：水位之后第一条 request/header；
 * 如果后面再没有 header，就沿用之前最近的（carry）。
 */
function governingProvider(session, afterSeq) {
  for (const event of eventsFrom(session, afterSeq + 1)) {
    if (event.type !== 'request/header') continue;
    const provider = event.data?.header?.config?.provider;
    if (typeof provider === 'string' && provider.length > 0) return provider;
  }
  return carryProvider(session, afterSeq);
}

/** 从 from 起第一条"官方渠道" request/header 的 seq；没有则 -1。 */
function firstOfficialHeader(session, from) {
  for (const event of eventsFrom(session, from)) {
    if (event.type !== 'request/header') continue;
    if (event.data?.header?.config?.provider === OFFICIAL_PROVIDER) return Number(event.seq);
  }
  return -1;
}

/** 待传区间里出现过哪些 provider；只有非官方渠道才归本插件管。 */
function classify(session, afterSeq) {
  const routes = new Map();
  for (const event of eventsFrom(session, afterSeq + 1)) {
    if (event.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (!config?.provider) continue;
    const route = `${config.provider}/${config.model ?? '?'}`;
    routes.set(route, (routes.get(route) ?? 0) + 1);
  }
  const entries = [...routes.entries()].map(([route, count]) => ({
    route,
    count,
    official: route.startsWith(`${OFFICIAL_PROVIDER}/`),
  }));
  if (entries.length === 0) {
    // 区间里没有新的 request/header：沿用之前最近的渠道，否则整段会被误判成"官方"。
    const carry = carryProvider(session, afterSeq);
    if (carry !== undefined) {
      entries.push({ route: `${carry}/?`, count: 0, official: carry === OFFICIAL_PROVIDER, carried: true });
    }
  }
  return {
    routes: entries,
    hasNonOfficial: entries.some((entry) => !entry.official),
    hasAny: entries.length > 0,
  };
}

/** 从 afterSeq 之后切出不超过 maxBytes 的最长连续段（记账法与核心一致）。 */
function segment(session, afterSeq, maxBytes, stopBefore = Infinity) {
  const envelope = {
    version: 1,
    sessionFormatVersion: session.header.version,
    session: wireHeader(session),
    afterSeq,
  };
  let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1;
  const chosen = [];
  const pending = eventsFrom(session, afterSeq + 1).filter((event) => Number(event.seq) < stopBefore);
  let blockedSeq = null;

  for (const event of pending) {
    let wire;
    try {
      wire = wireEvent(event);
    } catch {
      blockedSeq = Number(event.seq);
      break;
    }
    const next = bytes + (chosen.length === 0 ? 0 : 1) + jsonBytes(wire);
    if (next + String(event.seq).length > maxBytes) {
      blockedSeq = Number(event.seq);
      break;
    }
    bytes = next;
    chosen.push(wire);
  }

  if (chosen.length === 0) return { envelope: null, bytes: 0, blockedSeq };
  const throughSeq = chosen[chosen.length - 1].seq;
  const full = { ...envelope, throughSeq, events: chosen };
  const actual = jsonBytes(full);
  if (actual > maxBytes) return { envelope: null, bytes: 0, blockedSeq: throughSeq };
  // blockedSeq 为 null 表示这一段把待传事件全装下了；非 null 表示被截断，还有下一段。
  return { envelope: full, bytes: actual, blockedSeq };
}

/* ────────────────────────── 上传 ────────────────────────── */

function keyHint(key) {
  if (typeof key !== 'string' || key.length < 10) return '(short key)';
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/**
 * 在途请求的控制器：卸载时要能主动掐断，否则卸载后还会写水位。
 * 集合由调用方持有（每个插件实例一份），卸载不会误伤同进程的其它实例。
 */
async function postOnce(body, apiKey, controllers, timeoutMs = 60000) {
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: text.slice(0, 200),
      headers: typeof response.headers?.entries === 'function' ? Object.fromEntries(response.headers.entries()) : {},
    };
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
  }
}

/** 429 的 Retry-After：秒数或 HTTP 日期，解析不出就交给指数退避。 */
function parseRetryAfter(headers, status) {
  if (status !== 429) return undefined;
  const raw = headers?.['retry-after'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 600000);
  return undefined;
}

export function apply(ctx, config) {
  const logger = ctx.logger;
  const log = (level, message) => {
    try {
      logger?.[level]?.(`dsh-session-log-upload: ${message}`);
    } catch {
      /* 日志失败也不能影响会话 */
    }
  };

  /** 每个会话一个待执行定时器。 */
  const timers = new Map();
  /** 单飞：同一会话同时只允许一个上传任务。 */
  const inflight = new Set();
  /** 全局串行链。 */
  let chain = Promise.resolve();
  /** 限流窗口里的请求时间戳。 */
  const requestLog = [];
  /** 官方优先窗口每个会话只提醒一次。 */
  const officialNotified = new WeakSet();
  /** 每个会话连续失败次数：超过上限就不再自动重排，避免永久抢额度。 */
  const failStreak = new Map();
  /** 每个会话连续自动续传的轮数（防止喂自己）。 */
  const drainRounds = new Map();
  /** 阻塞事件只告警一次（WeakMap：会话销毁即回收）。 */
  const blockedWarned = new WeakMap();
  /** 计数器，观测用。 */
  const stats = { ok: 0, fail: 0, bytes: 0, skipped: 0 };
  /** 本实例在途请求的控制器。 */
  const activeControllers = new Set();
  /** 手动上传的冷却与单飞。 */
  let lastManualAt = 0;
  let manualBusy = false;
  const MANUAL_COOLDOWN_MS = 30_000;
  let disposed = false;

  const clearTimer = (sessionId) => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  };

  const takeBudget = (cfg) => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    while (requestLog.length > 0 && now - requestLog[0] > windowMs) requestLog.shift();
    if (requestLog.length >= Math.max(1, cfg.maxRequestsPerHour)) return false;
    requestLog.push(now);
    return true;
  };

  async function resolveKey(cfg) {
    try {
      const resolved = await ctx.credentials.resolve(cfg.apiKeyRef);
      if (resolved?.value) return resolved.value;
    } catch (error) {
      log('warn', `credential lookup failed: ${error?.message ?? error}`);
    }
    const fallback = process.env[cfg.apiKeyRef];
    return fallback || undefined;
  }

  /** 一个会话的一次完整上传（可能连发多段）。 */
  /**
   * 一个会话的一次上传（必要时连发多段）。
   * options.manual=true 绕过档位检查——手动按钮在任何档位都能触发。
   */
  async function uploadSession(session, options = {}) {
    const cfg = readConfig(config);
    if (!cfg.enabled) return { status: 'disabled' };
    if (cfg.mode === 'manual' && options.manual !== true) return { status: 'mode-off' };
    if (disposed) return { status: 'disposed' };
    const sessionId = String(session.id);

    // 会话可能已经在排队期间被销毁：不传，也不留队列项。
    const live = typeof ctx.sessions.get === 'function' ? ctx.sessions.get(session.id) : session;
    if (live === undefined) {
      clearTimer(sessionId);
      inflight.delete(sessionId);
      log('debug', `session=${sessionId} skipped (session no longer live)`);
      return { status: 'gone' };
    }
    session = live;

    const initialAfter = effectiveAfter(session, cfg);
    if (initialAfter === null) {
      stats.skipped += 1;
      log('debug', `session=${sessionId} skipped (seeded child, includeSeeded=false)`);
      return { status: 'seeded' };
    }

    const apiKey = await resolveKey(cfg);
    if (!apiKey) {
      log('warn', `session=${sessionId} skipped: no credential at ${cfg.apiKeyRef}`);
      return { status: 'no-key' };
    }

    let previousThrough = -1;
    for (let round = 0; round < MAX_SEGMENTS_PER_RUN; round += 1) {
      if (disposed) return { status: 'disposed' };
      const startAfter = effectiveAfter(session, cfg);
      if (startAfter === null) return { status: 'seeded' };

      const pendingCount = Number(session.seq) - (startAfter + 1);
      if (pendingCount <= 0) return { status: 'up-to-date' };

      // 这一段归谁管：水位之后第一个 header 决定；没 header 就沿用之前的渠道。
      const governing = governingProvider(session, startAfter);
      if (governing === undefined) {
        if (round === 0) {
          stats.skipped += 1;
          log('debug', `session=${sessionId} skipped (no provider record)`);
        }
        return { status: 'no-provider' };
      }
      if (governing === OFFICIAL_PROVIDER) {
        if (round === 0) {
          stats.skipped += 1;
          // 这一段只有内置插件能推水位。如果它没在推（用户关了内置开关、或 accept 失败），
          // 这条会话就会一直停在这里——必须让人看得见，而不是静默 debug。
          if (!officialNotified.has(session)) {
            officialNotified.add(session);
            log('warn', `session=${sessionId} pending window starts with an official request; built-in uploader owns it and has not advanced the watermark (enable the built-in switch if this stalls)`);
          }
        }
        return { status: 'official-only' };
      }

      // 从非官方这一段往后传，遇到官方 request/header 就停：官方那部分留给内置插件，
      // 避免同一条内容两条通道各发一遍。
      const boundary = firstOfficialHeader(session, startAfter + 1);
      const seg = segment(session, startAfter, cfg.maxBytes, boundary === -1 ? Infinity : boundary);
      if (!seg.envelope) {
        const blocked = seg.blockedSeq;
        if (blockedWarned.get(session) !== blocked) {
          blockedWarned.set(session, blocked);
          log('warn', `session=${sessionId} event ${blocked} exceeds maxBytes ${cfg.maxBytes}; watermark stays at ${startAfter}`);
        }
        return { status: 'blocked', blockedSeq: blocked };
      }

      const envelope = seg.envelope;
      const body = {
        model: cfg.model,
        messages: [{ role: 'user', content: '.' }],
        max_tokens: 1,
        stream: false,
        dsh_session_log: envelope,
      };

      let lastError = null;
      let accepted = false;
      let retryLater = false;
      const started = Date.now();
      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
        // 每一次真实 HTTP 尝试都扣额度：重试也是请求，不能只按"段"计。
        if (!takeBudget(cfg)) {
          log('info', `session=${sessionId} queued: hourly budget ${cfg.maxRequestsPerHour} reached`);
          schedule(session, 60000);
          return { status: 'budget' };
        }
        let result;
        try {
          result = await postOnce(body, apiKey, activeControllers);
        } catch (error) {
          if (disposed) return { status: 'disposed' };
          lastError = `network: ${error?.message ?? error}`;
          retryLater = true;
          if (attempt < cfg.maxAttempts) await sleep(cfg.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        if (result.ok) {
          accepted = true;
          break;
        }
        lastError = `HTTP ${result.status} ${result.body.replace(/\s+/g, ' ').slice(0, 120)}`;
        if (result.status === 401 || result.status === 403) {
          retryLater = false; // key 问题，重试无意义
          break;
        }
        if (result.status !== 429 && result.status < 500) {
          retryLater = false; // 其它 4xx 不重试
          break;
        }
        retryLater = true;
        if (attempt < cfg.maxAttempts) {
          const waitMs = parseRetryAfter(result.headers, result.status);
          await sleep(waitMs ?? cfg.baseDelayMs * 2 ** (attempt - 1));
        }
      }

      const elapsed = Date.now() - started;
      if (!accepted) {
        stats.fail += 1;
        log('warn', `session=${sessionId} seq=${startAfter}..${envelope.throughSeq} status=fail ${lastError ?? ''}`);
        // 429 / 5xx / 网络错误：重排，但连续失败太多次就停下来，别永久抢额度。
        const streak = (failStreak.get(sessionId) ?? 0) + 1;
        failStreak.set(sessionId, streak);
        if (retryLater && !disposed) {
          if (streak <= MAX_AUTO_RETRY_STREAK) {
            schedule(session, Math.max(cfg.baseDelayMs, 60000) * Math.min(streak, 5));
          } else if (streak === MAX_AUTO_RETRY_STREAK + 1) {
            log('warn', `session=${sessionId} giving up auto-retry after ${streak} consecutive failures; will retry on the next turn`);
          }
        }
        return { status: 'failed', error: lastError };
      }

      if (disposed) return { status: 'disposed' };
      try {
        session.append(ACCEPTANCE_EVENT, {
          sessionId: session.id,
          sessionFormatVersion: session.header.version,
          throughSeq: envelope.throughSeq,
        });
      } catch (error) {
        stats.fail += 1;
        log('warn', `session=${sessionId} watermark append failed: ${error?.message ?? error}`);
        return { status: 'append-failed' };
      }
      failStreak.delete(sessionId);
      stats.ok += 1;
      stats.bytes += seg.bytes;
      log('info', `session=${sessionId} seq=${startAfter}..${envelope.throughSeq} events=${envelope.events.length} bytes=${seg.bytes} status=200 ms=${elapsed}`);

      // blockedSeq 为 null：这一段装下了全部待传事件，收工。
      // 非 null：被 maxBytes 截断，还有下一段——继续，但要防转圈。
      if (seg.blockedSeq === null) return { status: 'uploaded' };
      if (envelope.throughSeq <= previousThrough) return { status: 'uploaded' };
      previousThrough = envelope.throughSeq;
    }

    // 段数用尽但还有内容：立刻排下一轮。否则安静会话会永远停在半路，
    // 因为"下一次触发"对它来说等于重启或手动点击。
    const restAfter = effectiveAfter(session, cfg);
    // 只数"内容"事件：自己的 delivery-accepted 会被算进去，把"还剩多少"撑大。
    const rest = countPendingContent(session, restAfter);

    if (!disposed && rest > 0) {
      if (options.manual === true) {
        // 手动档不会自动续传（schedule 在 manual 档直接返回），别谎报"继续中"。
        log('info', `session=${sessionId} segment budget spent (${MAX_SEGMENTS_PER_RUN}), ${rest} event(s) left — click "Upload now" again to continue`);
        return { status: 'uploaded', remaining: rest };
      }
      const rounds = (drainRounds.get(sessionId) ?? 0) + 1;
      if (rounds <= MAX_DRAIN_ROUNDS) {
        drainRounds.set(sessionId, rounds);
        log('info', `session=${sessionId} segment budget spent (${MAX_SEGMENTS_PER_RUN}), continuing (${rounds}/${MAX_DRAIN_ROUNDS})`);
        schedule(session, 0);
        return { status: 'uploaded', remaining: rest };
      }
      drainRounds.delete(sessionId);
      log('warn', `session=${sessionId} stopped draining after ${MAX_DRAIN_ROUNDS} rounds with ${rest} event(s) left; will continue on the next turn`);
      return { status: 'uploaded', remaining: rest };
    }
    return { status: 'uploaded', remaining: 0 };
  }

  const sleepTimers = new Set();

  function sleep(ms) {
    if (disposed || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepTimers.delete(timer);
        resolve();
      }, ms);
      sleepTimers.add(timer);
    });
  }

  /** 入队：全局串行，同一会话单飞。 */
  function schedule(session, delayMs) {
    const cfg = readConfig(config);
    if (!cfg.enabled || cfg.mode === 'manual' || disposed) return;
    const sessionId = String(session.id);
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (disposed) return;
      // 排队期间可能已经切到「仅手动」或关掉了：到点必须重判，否则"关了还在发"。
      const live = readConfig(config);
      if (!live.enabled || live.mode === 'manual') return;
      chain = chain.then(async () => {
        if (inflight.has(sessionId) || disposed) return;
        inflight.add(sessionId);
        try {
          await uploadSession(session);
        } catch (error) {
          log('warn', `session=${sessionId} upload crashed: ${error?.message ?? error}`);
        } finally {
          inflight.delete(sessionId);
        }
      });
    }, Math.max(0, delayMs));
    timers.set(sessionId, timer);
  }

  /* 事件触发 */
  const offEvent = ctx.on('session/event', (session, event) => {
    const cfg = readConfig(config);
    if (!cfg.enabled || cfg.mode === 'manual') return;
    try {
      if (event.type === 'turn/end') {
        if (event.data?.reason?.kind === 'forked') return;
        drainRounds.delete(String(session.id));
        if (cfg.mode === 'realtime') schedule(session, 0);
        else schedule(session, cfg.idleDelayMs);
        return;
      }
      // deferred：窗口内又来新事件就重新计时，等于"空闲够久才发"。
      if (cfg.mode === 'deferred' && timers.has(String(session.id))) {
        schedule(session, cfg.idleDelayMs);
      }
    } catch (error) {
      log('warn', `event hook failed: ${error?.message ?? error}`);
    }
  });

  /**
   * 这一步之前/之后的全局计数差，用来判断这个会话到底传没传、有没有失败。
   * 走同一个 inflight 集合，避免和定时上传撞车把同一段发两遍。
   */
  async function uploadOne(session) {
    const sessionId = String(session.id);
    if (inflight.has(sessionId)) return { requests: 0, failures: 0, bytes: 0, skipped: true };
    inflight.add(sessionId);
    const before = { ok: stats.ok, fail: stats.fail, bytes: stats.bytes };
    let outcome = { status: 'unknown' };
    try {
      outcome = await uploadSession(session, { manual: true });
    } finally {
      inflight.delete(sessionId);
    }
    return {
      requests: stats.ok - before.ok,
      failures: stats.fail - before.fail,
      bytes: stats.bytes - before.bytes,
      skipped: false,
      status: outcome?.status,
      blockedSeq: outcome?.blockedSeq,
      remaining: outcome?.remaining ?? 0,
    };
  }

  /** 待传候选：水位之后有非官方渠道内容的活会话（与启动扫描同一判据）。 */
  function collectCandidates(cfg) {
    const candidates = [];
    let officialOwned = 0;
    for (const session of ctx.sessions.list()) {
      const after = effectiveAfter(session, cfg);
      if (after === null) continue;
      const pending = Number(session.seq) - (after + 1);
      if (pending <= 0) continue;
      // 与 uploadSession 同一口径：水位后第一段归官方就归内置插件，本插件不上传。
      // 但要单独计数——否则界面会把"归内置"和"已是最新"说成同一件事。
      const governing = governingProvider(session, after);
      if (governing === undefined) continue;
      if (governing === OFFICIAL_PROVIDER) {
        officialOwned += 1;
        continue;
      }
      candidates.push({ session, pending });
    }
    candidates.sort((a, b) => a.pending - b.pending);
    return { candidates, officialOwned };
  }

  /**
   * 设置页「立即上传」按钮的入口：把当前所有待传会话补一遍。
   * 返回码给浏览器端决定提示文案。
   */
  async function manualUpload() {
    const cfg = readConfig(config);
    if (!cfg.enabled) return { code: 'disabled' };
    if (manualBusy) return { code: 'busy' };
    // 先占位再 await：否则两次点击/两个标签页能同时穿过检查各跑一遍。
    manualBusy = true;

    let sessions = 0;
    let requests = 0;
    let failures = 0;
    let officialOwned = 0;
    let blocked = 0;
    let blockedSeq = null;
    let remaining = 0;
    let skippedInflight = 0;
    let bytes = 0;
    let candidateCount = 0;
    try {
      const since = Date.now() - lastManualAt;
      if (lastManualAt > 0 && since < MANUAL_COOLDOWN_MS) {
        return { code: 'cooldown', retryAfterMs: MANUAL_COOLDOWN_MS - since };
      }
      const collected = collectCandidates(cfg);
      const candidates = collected.candidates;
      officialOwned = collected.officialOwned;
      candidateCount = candidates.length;
      if (candidates.length === 0) {
        // 有内容、但归内置插件管：明确说出来，别和"已是最新"混成一句。
        if (officialOwned > 0) return { code: 'official-owned', sessions: 0, officialOwned };
        return { code: 'up-to-date', sessions: 0 };
      }
      if (!(await resolveKey(cfg))) return { code: 'no-key' };

      for (const { session } of candidates) {
        if (disposed) break;
        try {
          const result = await uploadOne(session);
          if (result.requests > 0) {
            sessions += 1;
            requests += result.requests;
            bytes += result.bytes;
          }
          failures += result.failures;
          if (result.skipped) skippedInflight += 1;
          remaining += result.remaining ?? 0;
          if (result.status === 'blocked') {
            blocked += 1;
            if (blockedSeq === null) blockedSeq = result.blockedSeq ?? null;
          }
        } catch (error) {
          failures += 1;
          log('warn', `manual upload failed for ${String(session.id)}: ${error?.message ?? error}`);
        }
      }
    } finally {
      manualBusy = false;
      if (requests > 0) lastManualAt = Date.now();
    }

    log('info', `manual upload: sessions=${sessions} requests=${requests} bytes=${bytes} failures=${failures} of ${candidateCount} candidate(s)`);
    if (requests > 0) return { code: 'uploaded', sessions, requests, bytes, officialOwned, remaining };
    // 一个请求都没成功但确实失败过：不能报"已是最新"，那是骗人。
    if (failures > 0) return { code: 'failed', sessions: 0, failures };
    // 有会话卡在"单条事件超过上限"：一个请求都发不出去，不能说成"已是最新"。
    if (blocked > 0) return { code: 'blocked', sessions: 0, blocked, blockedSeq, officialOwned };
    // 候选都在飞（另一次上传正在处理同样的会话）：这是"忙"，不是"已是最新"。
    if (skippedInflight > 0) return { code: 'busy', sessions: 0, inflight: skippedInflight };
    // 候选都归内置（no-provider 之类也会落到这里）：把计数带出去，别和"已是最新"混为一谈。
    if (officialOwned > 0) return { code: 'official-owned', sessions: 0, officialOwned };
    return { code: 'up-to-date', sessions: 0 };
  }

  /*
   * 浏览器侧「立即上传」按钮的 HTTP 入口。
   * 只接受同源 POST；落在本机监听端口上，不做写入磁盘之类的高危动作，
   * 最坏情况是重复触发一次上传（冷却 + 水位保证不会重复发送内容）。
   */
  const webServer = ctx.get?.('webServer');
  if (webServer?.register) {
    const unregister = webServer.register({
      kind: 'exact',
      path: '/__dsh-session-log-upload/upload',
      handler: async (req, res) => {
        const send = (status, payload) => {
          try {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify(payload));
          } catch {
            /* 连接已经断了，忽略 */
          }
        };
        if (req.method === 'OPTIONS') {
          return send(204, {});
        }
        if (req.method !== 'POST') return send(405, { ok: false, code: 'method' });
        // 自定义头是同源脚本才发得出来的；挡住"别的页面/随便一个本机进程 POST 一下"。
        if (req.headers['x-dsh-sync'] !== '1') return send(403, { ok: false, code: 'header' });
        const origin = req.headers.origin;
        if (origin !== undefined) {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(origin).host === req.headers.host;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) return send(403, { ok: false, code: 'origin' });
        }
        try {
          const result = await manualUpload();
          // ok 与结果码必须同口径：失败类是 false，其余（含 info 语气的 busy / official-owned）是 true。
          const ok = !['disabled', 'no-key', 'failed', 'cooldown', 'error', 'blocked'].includes(result.code);
          return send(200, { ok, ...result });
        } catch (error) {
          log('warn', `manual upload route failed: ${error?.message ?? error}`);
          return send(500, { ok: false, code: 'error' });
        }
      },
    });
    if (typeof unregister === 'function') ctx.effect(() => unregister);
  }

  /* 启动扫描：崩溃 / 强杀时收尾触发不会发生，这是唯一能补上的路径。 */
  const startupTimer = setTimeout(() => {
    if (disposed) return;
    const cfg = readConfig(config);
    if (!cfg.enabled) return;
    try {
      const { candidates, officialOwned } = collectCandidates(cfg);
      if (officialOwned > 0) {
        log('info', `startup scan: ${officialOwned} session(s) left to the built-in uploader`);
      }
      for (const { session } of candidates) {
        if (cfg.mode === 'manual') {
          log('info', `session=${session.id} pending non-official log (manual mode: not uploading)`);
        } else {
          schedule(session, cfg.mode === 'realtime' ? 0 : Math.min(cfg.idleDelayMs, 5000));
        }
      }
      if (candidates.length > 0) log('info', `startup scan queued ${candidates.length} session(s)`);
    } catch (error) {
      log('warn', `startup scan failed: ${error?.message ?? error}`);
    }
  }, 5000);

  /* 卸载：清干净，不留残留定时器。 */
  ctx.effect(() => () => {
    disposed = true;
    offEvent();
    clearTimeout(startupTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of sleepTimers) clearTimeout(timer);
    sleepTimers.clear();
    for (const controller of activeControllers) {
      try {
        controller.abort(new Error('disposed'));
      } catch {
        /* 已经结束的请求忽略 */
      }
    }
    activeControllers.clear();
    inflight.clear();
    requestLog.length = 0;
    log('info', `unloaded (ok=${stats.ok} fail=${stats.fail} bytes=${stats.bytes} skipped=${stats.skipped})`);
  });
}

__internals.readConfig = readConfig;
__internals.wireHeader = wireHeader;
__internals.wireEvent = wireEvent;
__internals.segment = segment;
__internals.acceptedThrough = acceptedThrough;
__internals.effectiveAfter = effectiveAfter;
__internals.classify = classify;
