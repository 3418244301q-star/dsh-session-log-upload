/**
 * 插件运行时验证：mock fetch + mock ctx，检查
 *   1) 非官方渠道会话会被上传，且水位写到正确 throughSeq
 *   2) 官方渠道会话不触发请求
 *   3) seeded 子会话默认跳过
 *   4) 限流超限时排队而不是丢弃
 *
 *   node tools/check-runtime.mjs
 */
import { apply } from '../index.js';

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function makeSession({ id, provider = 'ollama-local', isSeeded = false, seedLength = 0, formatV = 4, layout = 'normal' }) {
  const events = layout === 'seeded'
    // 前两条是继承来的旧事件，request/header 在继承段之后（子会话自己的轮次）
    ? [
        { type: 'user/message', seq: 0, time: 1, data: { message: { role: 'user', content: [] }, turn: 1, step: 1 }, surfaceOp: 'append' },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        {
          type: 'request/header',
          seq: 2,
          time: 3,
          data: { header: { config: { provider, model: 'qwen3:8b' } }, reason: 'initial' },
        },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      ]
    : [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header',
          seq: 1,
          time: 2,
          data: { header: { config: { provider, model: provider === 'deepseek-official' ? 'deepseek-flash' : 'qwen3:8b' } }, reason: 'initial' },
        },
        { type: 'user/message', seq: 2, time: 3, data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, turn: 1, step: 1 }, surfaceOp: 'append' },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
  const session = {
    header: { version: formatV, id, createdAt: 1, cwd: 'D:\\dsh\\test', isSeeded },
    inheritedEventCount: seedLength,
    id,
    seq: 4,
    appended: [],
    eventAt: (s) => events[s],
    snapshotEvents: (from = 0) => events.filter((e) => Number(e.seq) >= Number(from)),
    append(type, data) {
      this.appended.push({ type, data });
      // 模仿真实 Session：append 之后 seq 增长，事件可被再次读取
      const seq = events.length;
      events.push({ type, seq, time: 5, data });
      this.seq = events.length;
    },
  };
  return { session, events };
}

/** 造一个"事件很多、每条都不小"的会话，用来逼出多段续传。 */
function makeBulkSession({ id, count, pad = 200, switchAt = null, provider = 'ollama-local' }) {
  const filler = 'x'.repeat(pad);
  const events = [];
  for (let i = 0; i < count; i += 1) {
    if (i === 0 || (switchAt !== null && i === switchAt)) {
      const p = switchAt !== null && i >= switchAt ? provider : 'ollama-local';
      events.push({
        type: 'request/header',
        seq: i,
        time: i,
        data: { header: { config: { provider: p, model: 'm' } }, reason: 'initial' },
      });
    } else {
      events.push({
        type: 'user/message',
        seq: i,
        time: i,
        data: { message: { role: 'user', content: [{ type: 'text', text: filler }] }, turn: 1, step: 1 },
        surfaceOp: 'append',
      });
    }
  }
  return makeSessionFromEvents({ id, events });
}

function makeSessionFromEvents({ id, events }) {
  const session = {
    header: { version: 4, id, createdAt: 1, cwd: 'D:\dsh\test', isSeeded: false },
    inheritedEventCount: 0,
    id,
    seq: events.length,
    appended: [],
    eventAt: (s) => events[s],
    snapshotEvents: (from = 0) => events.filter((e) => Number(e.seq) >= Number(from)),
    append(type, data) {
      this.appended.push({ type, data });
      events.push({ type, seq: events.length, time: 99, data });
      this.seq = events.length;
    },
  };
  return { session, events };
}

async function boot(config, sessions) {
  const handlers = [];
  const disposers = [];
  const requests = [];
  const routes = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { status: 200, ok: true, text: async () => '{"ok":true}' };
  };
  const ctx = {
    logger: {
      entries: [],
      debug(message) { this.entries.push(['debug', message]); },
      info(message) { this.entries.push(['info', message]); },
      warn(message) { this.entries.push(['warn', message]); },
      error(message) { this.entries.push(['error', message]); },
    },
    credentials: { resolve: async () => ({ value: 'sk-test-0123456789abcdef' }) },
    sessions: {
      list: () => sessions.map((item) => item.session),
      get: (id) => sessions.map((item) => item.session).find((item) => String(item.id) === String(id)),
    },
    get(name) {
      if (name !== 'webServer') return undefined;
      return { register: (route) => { routes.push(route); return () => {}; } };
    },
    on(name, fn) {
      handlers.push({ name, fn });
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
  };
  apply(ctx, config);
  const emit = (session, event) => handlers.filter((h) => h.name === 'session/event').forEach((h) => h.fn(session, event));
  return {
    requests,
    emit,
    routes,
    logs: () => ctx.logger.entries,
    dispose: () => disposers.forEach((d) => d()),
  };
}

const base = {
  enabled: true,
  mode: 'realtime',
  idleDelayMs: 0,
  budget: { maxRequestsPerHour: 60 },
  retry: { maxAttempts: 1, baseDelayMs: 0 },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1) 非官方渠道：应当上传并落水位 */
{
  const { session } = makeSession({ id: 'session-ollama' });
  const { requests, emit } = await boot({ ...base }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  check('non-official session uploads once', requests.length === 1, `requests=${requests.length}`);
  const log = requests[0]?.dsh_session_log;
  check('payload is dsh_session_log v1', log?.version === 1 && log?.sessionFormatVersion === 4, `version=${log?.version}`);
  check('payload covers seq -1..3', log?.afterSeq === -1 && log?.throughSeq === 3, `after=${log?.afterSeq} through=${log?.throughSeq}`);
  check('payload carries all 4 events', log?.events?.length === 4, `events=${log?.events?.length}`);
  const accepted = session.appended.filter((a) => a.type === 'session-log-deepseek/delivery-accepted');
  check('watermark appended once', accepted.length === 1, `count=${accepted.length}`);
  check(
    'watermark is sessionId + format + throughSeq',
    accepted[0]?.data.sessionId === 'session-ollama' && accepted[0]?.data.sessionFormatVersion === 4 && accepted[0]?.data.throughSeq === 3,
    JSON.stringify(accepted[0]?.data),
  );
  check('request body is a minimal chat call', requests[0]?.model === 'deepseek-flash' && requests[0]?.max_tokens === 1 && requests[0]?.stream === false);
}

/* 2) 全是官方渠道：本插件不插手 */
{
  const { session } = makeSession({ id: 'session-official', provider: 'deepseek-official' });
  const { requests, emit } = await boot({ ...base }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  check('official-only session sends nothing', requests.length === 0, `requests=${requests.length}`);
  check('official-only session writes no watermark', session.appended.length === 0);
}

/* 3) seeded 子会话默认跳过 */
{
  const { session } = makeSession({ id: 'session-seeded', isSeeded: true, seedLength: 2, layout: 'seeded' });
  const { requests, emit } = await boot({ ...base }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  check('seeded child skipped by default', requests.length === 0, `requests=${requests.length}`);
}

/* 4) includeSeeded=true：只传继承段之后 */
{
  const { session } = makeSession({ id: 'session-seeded-2', isSeeded: true, seedLength: 2, layout: 'seeded' });
  const { requests, emit } = await boot({ ...base, includeSeeded: true }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  const log = requests[0]?.dsh_session_log;
  check('seeded child uploads only its own tail', log?.afterSeq === 1 && log?.throughSeq === 3, `after=${log?.afterSeq} through=${log?.throughSeq}`);
  check('seeded payload excludes inherited events', log?.events?.every((e) => e.seq > 1), JSON.stringify(log?.events?.map((e) => e.seq)));
}

/* 5) 限流：超限时排队不发 */
{
  const { session } = makeSession({ id: 'session-budget' });
  const { requests, emit } = await boot({ ...base, budget: { maxRequestsPerHour: 1 } }, [{ session }]);
  // 第一次用完唯一配额
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  const first = requests.length;
  // 再产生新事件并触发一轮，应当被限流挡住
  session.seq = 5;
  emit(session, { type: 'turn/end', seq: 4, time: 6, data: { turn: 2, reason: { kind: 'completed' } } });
  await wait(120);
  check('hourly budget blocks the second request', first === 1 && requests.length === 1, `requests=${requests.length}`);
}

/* 6) manual 档：零网络活动 */
{
  const { session } = makeSession({ id: 'session-manual' });
  const { requests, emit } = await boot({ ...base, mode: 'manual' }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  check('manual mode sends nothing', requests.length === 0, `requests=${requests.length}`);
}

function fakeRes() {
  const state = { statusCode: 0, body: '' };
  const res = {
    state,
    setHeader() {},
    end(text) { state.body = text; },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: (value) => { state.statusCode = value; },
  });
  return res;
}

/** 通过注册的 HTTP 路由发一次同源 POST。 */
const post = (route) => {
  const res = fakeRes();
  return route.handler({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-dsh-sync': '1' } }, res)
    .then(() => ({ status: res.statusCode, json: JSON.parse(res.state.body || '{}') }));
};

/* 7) 手动上传端点：结果码与 JSON 形状 */
{
  // 手动档 + 有待传内容 → uploaded
  {
    const { session } = makeSession({ id: 'session-manual-upload' });
    const { routes, requests } = await boot({ ...base, mode: 'manual' }, [{ session }]);
    const route = routes.find((r) => r.path === '/__dsh-session-log-upload/upload');
    check('registers the manual upload route', Boolean(route), routes.map((r) => r.path).join(','));
    const first = await post(route);
    check('manual upload reports uploaded', first.json.code === 'uploaded' && first.json.sessions === 1, JSON.stringify(first.json));
    check('manual upload actually sent one request', requests.length === 1, `requests=${requests.length}`);
    const second = await post(route);
    check('second click inside the cooldown is refused', second.json.code === 'cooldown' && second.json.retryAfterMs > 0, JSON.stringify(second.json));
  }

  // 无待传内容 → up-to-date
  {
    const { session } = makeSession({ id: 'session-official-only', provider: 'deepseek-official' });
    const { routes } = await boot({ ...base, mode: 'manual' }, [{ session }]);
    const result = await post(routes[0]);
    check('official-only history is reported as owned by the built-in uploader', result.json.code === 'official-owned', JSON.stringify(result.json));
  }

  // 插件关闭 → disabled
  {
    const { session } = makeSession({ id: 'session-off' });
    const { routes } = await boot({ ...base, mode: 'manual', enabled: false }, [{ session }]);
    const result = await post(routes[0]);
    check('disabled plugin refuses the manual upload', result.json.code === 'disabled', JSON.stringify(result.json));
  }

  // 缺少同源脚本头 → 403
  {
    const { session } = makeSession({ id: 'session-noheader' });
    const { routes } = await boot({ ...base, mode: 'manual' }, [{ session }]);
    const res = fakeRes();
    await routes[0].handler({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, res);
    check('request without the script header is rejected', res.statusCode === 403, String(res.statusCode));
  }

  // 跨源 → 403
  {
    const { session } = makeSession({ id: 'session-cors' });
    const { routes } = await boot({ ...base, mode: 'manual' }, [{ session }]);
    const res = fakeRes();
    await routes[0].handler({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example', 'x-dsh-sync': '1' } }, res);
    check('cross-origin request is rejected', res.statusCode === 403, String(res.statusCode));
  }
}

/* 8) 多段续传：一次传不完要接着传，水位推进到末尾 */
{
  const { session } = makeBulkSession({ id: 'session-bulk', count: 40, pad: 220 });
  const { requests, emit } = await boot({ ...base, maxBytes: 2000 }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 39, time: 9, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(300);
  const ranges = requests.map((r) => [r.dsh_session_log.afterSeq, r.dsh_session_log.throughSeq]);
  check('oversized history is split into several requests', requests.length >= 2, `requests=${requests.length} ranges=${JSON.stringify(ranges)}`);
  const contiguous = ranges.every((range, i) => i === 0 || range[0] === ranges[i - 1][1]);
  check('segments are contiguous', contiguous, JSON.stringify(ranges));
  const accepted = session.appended.filter((a) => a.type === 'session-log-deepseek/delivery-accepted').pop();
  check('watermark advances to the last uploaded event', accepted?.data.throughSeq === ranges[ranges.length - 1][1], JSON.stringify(accepted?.data));
}

/* 9) 混合渠道：被截断的第二段若只剩官方内容，不能再发 */
{
  const { session } = makeBulkSession({ id: 'session-mixed', count: 24, pad: 220, switchAt: 12, provider: 'deepseek-official' });
  const { requests, emit } = await boot({ ...base, maxBytes: 2000 }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 23, time: 9, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(300);
  const crossed = requests.filter((r) => r.dsh_session_log.events.some((e) => Number(e.seq) >= 12));
  check('no request crosses into the official half', crossed.length === 0, `requests=${requests.length} crossed=${crossed.length}`);
}

/* 10) 全部 500：报失败，不写水位 */
{
  const { session } = makeSession({ id: 'session-500' });
  const { routes } = await boot({ ...base, mode: 'manual', retry: { maxAttempts: 2, baseDelayMs: 0 } }, [{ session }]);
  globalThis.fetch = async () => ({ status: 500, ok: false, text: async () => 'boom', headers: { entries: () => [] } });
  const result = await post(routes[0]);
  check('all-500 surfaces a failure, not "up to date"', result.json.code === 'failed' && result.json.failures > 0, JSON.stringify(result.json));
  check('failed upload writes no watermark', session.appended.length === 0);
}

/* 11) 429：按 Retry-After 重试，成功即收 */
{
  const { session } = makeSession({ id: 'session-429' });
  const { requests, emit } = await boot({ ...base, retry: { maxAttempts: 3, baseDelayMs: 0 } }, [{ session }]);
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call += 1;
    requests.push(JSON.parse(init.body));
    if (call === 1) return { status: 429, ok: false, text: async () => 'slow down', headers: { entries: () => [['retry-after', '0']] } };
    return { status: 200, ok: true, text: async () => '{}', headers: { entries: () => [] } };
  };
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(200);
  check('429 is retried instead of abandoned', requests.length === 2 && session.appended.length === 1, `requests=${requests.length} watermark=${session.appended.length}`);
}

/* 12) 降档到「仅手动」：已排队的定时任务必须作废 */
{
  const { session } = makeSession({ id: 'session-downgrade' });
  const config = { ...base, mode: 'deferred', idleDelayMs: 80 };
  const { requests, emit } = await boot(config, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  config.mode = 'manual';
  await wait(200);
  check('downgrading to manual cancels the queued upload', requests.length === 0, `requests=${requests.length}`);
}

/* 13) 手动与定时并发：同一段只能发一次 */
{
  const { session } = makeSession({ id: 'session-race' });
  const { requests, emit, routes } = await boot({ ...base, mode: 'deferred', idleDelayMs: 0 }, [{ session }]);
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    await wait(120);
    return { status: 200, ok: true, text: async () => '{}', headers: { entries: () => [] } };
  };
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(20);
  const reply = await post(routes[0]);
  await wait(300);
  check('manual and scheduled uploads never double-send', requests.length === 1, `requests=${requests.length} reply=${JSON.stringify(reply.json)}`);
}

/* 14) 卸载后不再写水位 */
{
  const { session } = makeSession({ id: 'session-unload' });
  const { emit, dispose } = await boot({ ...base }, [{ session }]);
  let aborted = false;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(60);
  dispose();
  await wait(120);
  check('unload aborts the in-flight request', aborted === true);
  check('unload writes no watermark afterwards', session.appended.length === 0);
}

/* 15) R1：水位后第一段归官方时，本插件认账并告警，不谎报有活可干 */
{
  const events = [
    { type: 'request/header', seq: 0, time: 0, data: { header: { config: { provider: 'deepseek-official', model: 'm' } }, reason: 'initial' } },
    { type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: [] }, turn: 1, step: 1 }, surfaceOp: 'append' },
    { type: 'request/header', seq: 2, time: 2, data: { header: { config: { provider: 'ollama-local', model: 'm' } }, reason: 'change' } },
    { type: 'user/message', seq: 3, time: 3, data: { message: { role: 'user', content: [] }, turn: 2, step: 1 }, surfaceOp: 'append' },
  ];
  const { session } = makeSessionFromEvents({ id: 'session-official-first', events });
  const { requests, emit, routes, logs } = await boot({ ...base, mode: 'realtime' }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  check('official-first window is left to the built-in uploader', requests.length === 0, `requests=${requests.length}`);
  check('official-first window is warned about', logs().some(([level, message]) => level === 'warn' && /official request/.test(message)), JSON.stringify(logs().slice(-2)));
  const manual = await post(routes[0]);
  check('manual click names the built-in uploader instead of saying up to date', manual.json.code === 'official-owned' && manual.json.officialOwned === 1, JSON.stringify(manual.json));
}

/* 16) R2：8 段用尽要自动接着传，不能停半路 */
{
  const { session } = makeBulkSession({ id: 'session-exhaust', count: 40, pad: 220 });
  const { requests, emit, logs } = await boot({ ...base, maxBytes: 900 }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 39, time: 9, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(600);
  const accepted = session.appended.filter((a) => a.type === 'session-log-deepseek/delivery-accepted').pop();
  check('segment budget exhaustion keeps draining', requests.length > 8, `requests=${requests.length}`);
  // 日志在尾部会不断追加 delivery-accepted，所以"末尾"一直在长；这里只要求原始内容传完。
  check('draining covers all original events', (accepted?.data.throughSeq ?? -1) >= 39, `throughSeq=${accepted?.data.throughSeq}`);
}

/* 17) R3：在途时点手动按钮，要报「忙」而不是「已是最新」 */
{
  const { session } = makeSession({ id: 'session-busy' });
  const { emit, routes } = await boot({ ...base, mode: 'deferred', idleDelayMs: 0 }, [{ session }]);
  globalThis.fetch = (_url, init) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 200, ok: true, text: async () => '{}', headers: { entries: () => [] } }), 150);
    init.signal.addEventListener('abort', () => clearTimeout(timer));
  });
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(30);
  const reply = await post(routes[0]);
  await wait(250);
  check('manual click while an upload is in flight reports busy', reply.json.code === 'busy', JSON.stringify(reply.json));
}

/* 18) 观察项5：inheritedEventCount 缺失时不写出 seedLength: null */
{
  const { session } = makeSession({ id: 'session-seedless', isSeeded: true, seedLength: Number.NaN });
  const { requests, emit } = await boot({ ...base, includeSeeded: true }, [{ session }]);
  emit(session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(120);
  const log = requests[0]?.dsh_session_log;
  check('missing seed length is omitted, not serialized as null', log !== undefined && !('seedLength' in log.session), JSON.stringify(log?.session));
}

/* 19) R5：单条事件就超上限时，手动点击要报 blocked，不能说"已是最新" */
{
  const huge = 'y'.repeat(200 * 1024);
  const events = [
    { type: 'request/header', seq: 0, time: 0, data: { header: { config: { provider: 'ollama-local', model: 'm' } }, reason: 'initial' } },
    { type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: huge }] }, turn: 1, step: 1 }, surfaceOp: 'append' },
    // 预置一条接受记录，把水位推到 0：此时第一条待传事件就是那条超大事件
    { type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 2, data: { sessionId: 'session-oversized', sessionFormatVersion: 4, throughSeq: 0 } },
  ];
  const { session } = makeSessionFromEvents({ id: 'session-oversized', events });
  const { requests, routes } = await boot({ ...base, mode: 'manual', maxBytes: 2000, retry: { maxAttempts: 1, baseDelayMs: 0 } }, [{ session }]);
  const reply = await post(routes[0]);
  check('oversized first event reports blocked, not up to date', reply.json.code === 'blocked' && reply.json.blocked === 1, JSON.stringify(reply.json));
  check('blocked result is not reported as ok', reply.json.ok === false, JSON.stringify({ ok: reply.json.ok }));
  check('blocked result sends nothing', requests.length === 0, `requests=${requests.length}`);
}

/* 20) ok 字段与结果码口径一致：info 语气的码不应回 ok:false */
{
  const { session } = makeSession({ id: 'session-okflag' });
  const { routes } = await boot({ ...base, mode: 'manual' }, [{ session }]);
  globalThis.fetch = async () => ({ status: 200, ok: true, text: async () => '{}', headers: { entries: () => [] } });
  const first = await post(routes[0]);
  const second = await post(routes[0]);
  check('cooldown is not ok', second.json.code === 'cooldown' && second.json.ok === false, JSON.stringify(second.json));
  check('a successful upload is ok', first.json.code === 'uploaded' && first.json.ok === true, JSON.stringify(first.json));
}

/* 21) M6：manual 档点一次只发 8 段，要如实告知还剩多少、且不许谎报"继续中" */
{
  const { session } = makeBulkSession({ id: 'session-manual-bulk', count: 40, pad: 220 });
  const { requests, routes, logs } = await boot({ ...base, mode: 'manual', maxBytes: 900 }, [{ session }]);
  const reply = await post(routes[0]);
  check('manual click stops at the segment budget', requests.length === 8, `requests=${requests.length}`);
  check('manual reply reports what is left', reply.json.code === 'uploaded' && reply.json.remaining > 0, JSON.stringify(reply.json));
  check(
    'manual log tells the user to click again',
    logs().some(([, message]) => /click "Upload now" again/.test(message)),
    JSON.stringify(logs().filter(([level]) => level !== 'info').slice(-2)),
  );
  check(
    'manual run never claims to keep draining on its own',
    !logs().some(([, message]) => /continuing \(\d\/\d\)/.test(message)),
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
