/**
 * Client 半场的离线验证：不打开浏览器，直接把 client.js 塞进一个假
 * __ModuleLoader__ 里跑，检查
 *   - factory 能产出 { inject, apply }
 *   - apply 会在 settings.general.item 注册 id=session-log-anywhere、order=91
 *   - 组件渲染出的是主题化控件（按钮+浮层、开关），不是原生 <select>/<input>
 *   - 三档选项齐全、当前档打勾、切换会写 Host 配置
 *
 *   node tools/check-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

const results = [];
const check = (label, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/*
 * 极简 React 替身：createElement 产出可检查的树，hooks 用持久化 slot 实现，
 * setState 会标记"需要重渲染"，这样点击按钮之后的结果提示也能被断言到。
 */
let hookSlots = [];
let hookIndex = 0;
let pendingRerender = false;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const slot = hookIndex++;
    if (hookSlots[slot] === undefined) hookSlots[slot] = initial;
    return [hookSlots[slot], (next) => {
      hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next;
      pendingRerender = true;
    }];
  },
  useRef() {
    const slot = hookIndex++;
    if (hookSlots[slot] === undefined) hookSlots[slot] = { current: null };
    return hookSlots[slot];
  },
  useEffect() {
    hookIndex++;
  },
  Fragment: Symbol.for('react.fragment'),
};

/** 从 client.js 里取出真实的 zh 文案表，t() 用它，断言才能校验正文与占位符替换。 */
const ZH = (() => {
  const head = SOURCE.indexOf('const zh = {');
  if (head < 0) throw new Error('cannot locate the zh locale table in client.js');
  const open = SOURCE.indexOf('{', head);
  const close = SOURCE.indexOf('\n    };', open);
  if (close < 0) throw new Error('cannot find the end of the zh locale table');
  return new Function('return {' + SOURCE.slice(open + 1, close) + '};')();
})();

let spec = null;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      spec = value;
    },
  },
};
globalThis.document = undefined; // 短路样式注入

new Function('window', SOURCE)(globalThis.window);

check('module loader id equals package name', spec?.id === 'dsh-session-log-upload', spec?.id);

/** 把节点树里的纯文本按顺序收出来（弹层把多行文案塞在一个节点里传进来）。 */
function flatText(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => flatText(child, out));
  else if (node && typeof node === 'object') flatText(node.children ?? [], out);
  return out;
}

/** 官方风险确认弹层的替身：只记录 props，断言关心的是"弹了没有、确认有没有拦住"。 */
const FakeRisk = (props) => React.createElement('div', {
  className: 'fake-risk',
  'data-open': String(props.open),
  'data-acknowledged': String(props.acknowledged),
  'data-title': props.title,
  'data-lines': flatText(props.description).join('/'),
  onAcknowledgedChange: props.onAcknowledgedChange,
  onConfirm: props.onConfirm,
  onCancel: props.onCancel,
}, props.acknowledgeLabel ?? null, props.confirmLabel ?? null);

/** 按不同的依赖条件装配一份模块：primitives 是否存在决定走弹窗还是行内面板。 */
function loadModule({ withPrimitives }) {
  new Function('window', SOURCE)(globalThis.window);
  return spec.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && withPrimitives) return { RiskConfirmation: FakeRisk };
    throw new Error(`unexpected require: ${name}`);
  });
}

const mod = loadModule({ withPrimitives: true });
check('factory returns apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), JSON.stringify(mod.inject));

/* 假 Host 侧 */
const writes = [];
const form = {
  set: async (key, value) => {
    writes.push([key, value]);
    return true;
  },
};
let registered = null;
const injectedInto = [];
let servedFor = null;
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: { register: () => () => {} },
  configForms: {
    get: () => form,
    whileServed: (namespaces, cb) => {
      servedFor = namespaces;
      cb();
      return () => {};
    },
  },
  slots: {
    inject: (name, cb) => {
      injectedInto.push(name);
      cb();
      return () => {};
    },
    register: (options, component) => {
      registered = { options, component };
      return () => {};
    },
  },
};

mod.apply(ctx);

check('waits for the Host config to be served', servedFor?.[0] === 'dsh-session-log-upload', JSON.stringify(servedFor));
check('registers into settings.general.item', injectedInto.includes('settings.general.item'), JSON.stringify(injectedInto));
check('row id is the package namespace', registered?.options.id === 'dsh-session-log-upload', registered?.options.id);
check('row sits right below the official row (order 91)', registered?.options.order === 91, String(registered?.options.order));

const face = registered.options.inject();

/**
 * 挂载一次。hooks 顺序：busy、notice、useEffect（SettingsRow）→ open、active（ModeSelect）。
 * 传入已有的 slots 就是"重新渲染"，用于观察 setState 之后的结果。
 */
function render(state, options = {}, slots) {
  hookSlots = slots ?? [
    options.busy === true,
    options.notice ?? null,
    options.confirming === true,   // SettingsRow：是否处于风险确认
    options.riskAck === true,      // SettingsRow：确认框是否已勾选
    undefined,                     // SettingsRow 的 useEffect 槽位
    options.open === true,
    options.openIndex ?? 0,
  ];
  const props = {
    useConfig: (selector) => selector({ value: state, status: 'ready', writable: true }),
    setMode: face.setMode,
    setEnabled: face.setEnabled,
    setAcknowledged: face.setAcknowledged,
    t: (key) => ZH[key] ?? key,
  };
  for (let pass = 0; pass < 8; pass += 1) {
    hookIndex = 0;
    pendingRerender = false;
    const tree = expand(registered.component(props));
    if (!pendingRerender) return tree;
  }
  hookIndex = 0;
  return expand(registered.component(props));
}

/** 把函数型节点当成组件调用展开，得到真实渲染树。 */
function expand(node, depth = 0) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function' && depth < 8) {
    return expand(node.type({ ...node.props, children: node.children }), depth + 1);
  }
  return { ...node, children: expandChildren(node.children, depth) };
}

/** children 里可能是数组（map 出来的列表），拍平。 */
function expandChildren(list, depth) {
  const out = [];
  for (const child of list ?? []) {
    if (Array.isArray(child)) out.push(...expandChildren(child, depth));
    else out.push(expand(child, depth));
  }
  return out;
}

function findBy(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findBy(child, predicate, out);
  return out;
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

/* 关闭状态 */
const tree = render({ enabled: true, mode: 'deferred' });
const texts = collectText(tree);
check('renders the title', texts.includes(ZH.title), texts.join('|'));
check('renders the description for the current mode', texts.includes(ZH.descDeferred), texts.join('|'));

const natives = findBy(tree, (n) => n.type === 'select' || (n.type === 'input' && n.props?.type === 'checkbox'));
check('no native select/checkbox in the row', natives.length === 0, `found=${natives.length}`);

const trigger = findBy(tree, (n) => n.type === 'button' && n.props?.['aria-haspopup'] === 'listbox')[0];
check('renders the themed dropdown trigger', Boolean(trigger));
check('trigger shows the current mode', collectText(trigger).includes(ZH.modeDeferred), collectText(trigger).join('|'));
check('trigger is enabled when the form is ready', trigger?.props?.disabled === false);

const toggle = findBy(tree, (n) => n.type === 'button' && n.props?.role === 'switch')[0];
check('renders the themed switch', Boolean(toggle));
check('switch reflects the enabled state', toggle?.props?.['aria-checked'] === true);

/* 展开状态 */
const opened = render({ enabled: true, mode: 'deferred' }, { open: true });
const menu = findBy(opened, (n) => n.type === 'ul' && n.props?.role === 'listbox')[0];
check('opens a themed popup instead of a native menu', Boolean(menu));
const options = findBy(menu ?? { children: [] }, (n) => n.props?.role === 'option');
check('popup offers all three modes', options.length === 3, options.map((o) => o.props?.key).join(','));
check('current mode is ticked', options.filter((o) => o.props?.['aria-selected'] === true).length === 1);
check('options carry the localized labels', collectText(menu).join('|').includes(ZH.modeManual), collectText(menu).join('|'));

/* 立即上传按钮 */
const deferredTree = render({ enabled: true, mode: 'deferred' });
const uploadBtn = findBy(deferredTree, (n) => n.props?.className === 'sla-upload')[0];
check('renders the upload button', Boolean(uploadBtn));
check('button is dimmed unless the mode is manual', uploadBtn?.props?.disabled === true);
check('button explains why it is dimmed', uploadBtn?.props?.title === ZH.uploadHintManual, String(uploadBtn?.props?.title));

const manualTree = render({ enabled: true, mode: 'manual' });
const manualBtn = findBy(manualTree, (n) => n.props?.className === 'sla-upload')[0];
check('button becomes active in manual mode', manualBtn?.props?.disabled === false);
check('button is disabled while the plugin is off', findBy(render({ enabled: false, mode: 'manual' }), (n) => n.props?.className === 'sla-upload')[0]?.props?.disabled === true);

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init?.method });
  return { json: async () => ({ ok: true, code: 'uploaded', sessions: 2, bytes: 20480 }) };
};
await manualBtn.props.onClick();
check('clicking posts to the host endpoint', calls.length === 1 && calls[0].url === '/__dsh-session-log-upload/upload' && calls[0].method === 'POST', JSON.stringify(calls));

const noticeTree = render({ enabled: true, mode: 'manual' }, { notice: { tone: 'success', text: 'noticeUploaded' } });
const noticeNode = findBy(noticeTree, (n) => n.props?.className === 'sla-notice')[0];
check('renders the result notice', Boolean(noticeNode), collectText(noticeTree).join('|'));
check('notice carries its tone', noticeNode?.props?.['data-tone'] === 'success');

/* 风险确认：首次开启必须过一遍 */
{
  const before = writes.length;
  const fresh = render({ enabled: false, mode: 'deferred' });
  const switchNode = findBy(fresh, (n) => n.type === 'button' && n.props?.role === 'switch')[0];
  switchNode.props.onClick();
  const afterToggle = render({ enabled: false, mode: 'deferred' }, {}, hookSlots);
  const risk = findBy(afterToggle, (n) => n.props?.className === 'fake-risk')[0];
  check('first enable opens the confirmation before turning on', Boolean(risk), collectText(afterToggle).join('|'));
  check('confirmation is titled as an enable action', risk?.props?.['data-title'] === ZH.riskTitle, String(risk?.props?.['data-title']));
  check('confirmation spells out all three risk lines', risk?.props?.['data-lines'] === [ZH.riskLine1, ZH.riskLine2, ZH.riskLine3].join('/'), String(risk?.props?.['data-lines']));
  check('confirm stays disabled until acknowledged', risk?.props?.['data-acknowledged'] === 'false', String(risk?.props?.['data-acknowledged']));
  check('nothing was written just by opening the confirmation', writes.length === before, JSON.stringify(writes.slice(before)));
  check('switch is still off while the confirmation is open', findBy(afterToggle, (n) => n.type === 'button' && n.props?.role === 'switch')[0]?.props?.['aria-checked'] === false);

  // 勾选 → 再点确认
  risk.props.onAcknowledgedChange(true);
  const acked = render({ enabled: false, mode: 'deferred' }, {}, hookSlots);
  const ackedRisk = findBy(acked, (n) => n.props?.className === 'fake-risk')[0];
  check('the acknowledgement is reflected back into the dialog', ackedRisk?.props?.['data-acknowledged'] === 'true');
  ackedRisk.props.onConfirm();
  check('confirming records the acknowledgement', writes.some(([k, v]) => k === 'acknowledged' && v === true), JSON.stringify(writes.slice(before)));
  check('confirming enables the plugin', writes.some(([k, v]) => k === 'enabled' && v === true), JSON.stringify(writes.slice(before)));

  // 已经确认过：开关直通，不再弹
  const againWrites = writes.length;
  const known = render({ enabled: false, mode: 'deferred', acknowledged: true });
  findBy(known, (n) => n.type === 'button' && n.props?.role === 'switch')[0].props.onClick();
  check('a returning user is not asked twice', findBy(render({ enabled: false, mode: 'deferred', acknowledged: true }, {}, hookSlots), (n) => n.props?.className === 'fake-risk').length === 0);
  check('a returning user enables straight away', writes.slice(againWrites).some(([k, v]) => k === 'enabled' && v === true), JSON.stringify(writes.slice(againWrites)));

  // 关闭方向不做确认
  const offWrites = writes.length;
  const on = render({ enabled: true, mode: 'deferred', acknowledged: true });
  findBy(on, (n) => n.type === 'button' && n.props?.role === 'switch')[0].props.onClick();
  check('turning it off needs no confirmation', writes.slice(offWrites).every(([k]) => k !== 'acknowledged') && writes.slice(offWrites).some(([k, v]) => k === 'enabled' && v === false), JSON.stringify(writes.slice(offWrites)));
}

/* 老核心没有 RiskConfirmation：确认就地展开，判定不变 */
{
  const main = registered;
  const legacy = loadModule({ withPrimitives: false });
  legacy.apply(ctx);
  const legacyFace = registered.options.inject();
  const legacyState = { value: { enabled: false, mode: 'deferred' }, status: 'ready', writable: true };
  const props = {
    useConfig: (selector) => selector(legacyState),
    setMode: legacyFace.setMode,
    setEnabled: legacyFace.setEnabled,
    setAcknowledged: legacyFace.setAcknowledged,
    t: (key) => ZH[key] ?? key,
  };
  hookSlots = [false, null, false, false, undefined, false, 0];
  hookIndex = 0;
  let tree2 = expand(registered.component(props));
  findBy(tree2, (n) => n.type === 'button' && n.props?.role === 'switch')[0].props.onClick();
  hookIndex = 0;
  tree2 = expand(registered.component(props));
  const panel = findBy(tree2, (n) => n.props?.className === 'sla-risk')[0];
  check('legacy core falls back to an inline confirmation', Boolean(panel), collectText(tree2).join('|'));
  check('inline confirmation repeats all three risk lines', panel ? findBy(panel, (n) => n.props?.className === 'sla-risk-line').length === 3 : false);
  const guard = findBy(tree2, (n) => n.props?.className === 'sla-primary')[0];
  check('inline confirmation keeps confirm disabled until acknowledged', guard?.props?.disabled === true);
  const box = findBy(tree2, (n) => n.props?.className === 'sla-check')[0];
  check('inline confirmation uses a themed checkbox', box?.props?.role === 'checkbox' && box?.props?.['aria-checked'] === false);
  registered = main; // 换回主模块，后面的用例继续用它
}

/* 写入 */
face.setMode('manual');
face.setEnabled(false);
check('mode write reaches the Host config', writes.some(([k, v]) => k === 'mode' && v === 'manual'), JSON.stringify(writes));
check('enable write reaches the Host config', writes.some(([k, v]) => k === 'enabled' && v === false), JSON.stringify(writes));

/* 未开启时 */
const disabledTree = render({ enabled: false, mode: 'manual' });
const disabledTexts = collectText(disabledTree);
check('shows the privacy note while disabled', disabledTexts.includes(ZH.disabledNote), disabledTexts.join('|'));

/* 结果码 → 界面提示：三个"零请求但非最新"的码必须有各自的分支与色调 */
async function noticeFor(payload) {
  globalThis.fetch = async () => ({ json: async () => payload });
  const tree = render({ enabled: true, mode: 'manual' });
  const button = findBy(tree, (n) => n.props?.className === 'sla-upload')[0];
  const stateSlots = hookSlots;   // 同一份 hooks 槽位，模拟"重新渲染"
  await button.props.onClick();
  const after = render({ enabled: true, mode: 'manual' }, {}, stateSlots);
  const node = findBy(after, (n) => n.props?.className === 'sla-notice')[0];
  return { tone: node?.props?.['data-tone'], text: collectText(after).join('|') };
}

{
  const blocked = await noticeFor({ ok: false, code: 'blocked', blocked: 2 });
  check('blocked result shows an error notice', blocked.tone === 'error' && blocked.text.includes(ZH.noticeBlocked.replace('{n}', '2')), JSON.stringify(blocked));
  check('blocked notice has its placeholder filled', !blocked.text.includes('{n}'), JSON.stringify(blocked.text));

  const busy = await noticeFor({ ok: true, code: 'busy', inflight: 1 });
  check('busy result shows an info notice', busy.tone === 'info' && busy.text.includes(ZH.noticeBusy), JSON.stringify(busy));

  const owned = await noticeFor({ ok: true, code: 'official-owned', officialOwned: 3 });
  check('official-owned result shows its own notice', owned.tone === 'info' && owned.text.includes(ZH.noticeOfficialOwned.replace('{n}', '3')), JSON.stringify(owned));
  check('official-owned notice has its placeholder filled', !owned.text.includes('{n}'), JSON.stringify(owned.text));

  const done = await noticeFor({ ok: true, code: 'uploaded', sessions: 2, bytes: 20480, remaining: 7 });
  const expected = ZH.noticeUploaded.replace('{sessions}', '2').replace('{kb}', '20') + ZH.noticeUploadedMore.replace('{n}', '7');
  check('uploaded notice reports what is still pending', done.text.includes(expected), JSON.stringify({ done, expected }));
}

const failed = results.filter((p) => !p).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
