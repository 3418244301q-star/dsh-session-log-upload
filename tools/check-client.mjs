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
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
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
    undefined, // SettingsRow 的 useEffect 槽位
    options.open === true,
    options.openIndex ?? 0,
  ];
  const props = {
    useConfig: (selector) => selector({ value: state, status: 'ready', writable: true }),
    setMode: face.setMode,
    setEnabled: face.setEnabled,
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
