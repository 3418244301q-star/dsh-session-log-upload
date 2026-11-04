window.__ModuleLoader__.load({
  id: 'dsh-session-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*
     * 控件全部只用主题 token，不写死颜色：
     * 官方亮色/暗色，以及带自定义主题的皮肤，都会自动跟上。
     * 也因此不用原生 <select>/<input type=checkbox>——它们的浮层和勾选框由系统绘制，
     * 永远是浅色，压不住暗色主题。
     */
    const css = [
      '.sla-row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.sla-title{font-size:14px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-primary)}',
      '.sla-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.sla-note{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px;opacity:.75}',
      '.sla-right{display:flex;align-items:center;gap:12px;flex:0 0 auto}',
      '.sla-actions{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}',
      '.sla-upload{-webkit-appearance:none;appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:4px 12px;font:inherit;font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer;transition:opacity .12s ease,border-color .12s ease}',
      '.sla-upload:hover:not(:disabled){opacity:.82}',
      '.sla-upload:active:not(:disabled){opacity:.7}',
      '.sla-upload:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.sla-upload:disabled{opacity:.4;cursor:not-allowed}',
      '.sla-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.sla-notice[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}',
      '.sla-notice[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.sla-select{position:relative}',
      '.sla-trigger{-webkit-appearance:none;appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:space-between;gap:10px;min-width:126px;padding:6px 10px;font:inherit;font-size:13px;line-height:18px;font-weight:400;text-align:left;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.sla-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.sla-trigger:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.sla-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.sla-trigger:disabled{opacity:.45;cursor:not-allowed}',
'.sla-chevron{flex:0 0 auto;opacity:.55}',
      '.sla-menu{box-sizing:border-box;position:absolute;top:calc(100% + 6px);right:0;min-width:100%;margin:0;padding:4px;list-style:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);z-index:40}',
      '.sla-option{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:6px 10px;border-radius:6px;font-size:13px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;white-space:nowrap}',
      '.sla-option:hover,.sla-option[data-active="true"]{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.sla-option[aria-selected="true"] .sla-tick{color:var(--dsw-alias-brand-primary)}',
      '.sla-tick{flex:0 0 auto;opacity:.9}',
      '.sla-switch{-webkit-appearance:none;appearance:none;box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));cursor:pointer;transition:background .15s ease}',
      '.sla-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.sla-switch:disabled{opacity:.45;cursor:not-allowed}',
      '.sla-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s ease}',
      '.sla-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.sla-switch[aria-checked="true"]::after{transform:translateX(16px)}',
    ].join('');
    const tagId = 'dsh-session-sync/SettingsRow.module.css';
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-sync';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* 图标直接用 currentColor 描边，跟着文字颜色走。 */
    const chevron = () => h('svg', { className: 'sla-chevron', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true },
      h('path', { d: 'M2 3.5 5 6.5 8 3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    const tick = () => h('svg', { className: 'sla-tick', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
      h('path', { d: 'M2.5 6.2 4.8 8.5 9.5 3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));

    const en = {
      title: 'Upload Session Log for third-party channels',
      enable: 'Enable cross-channel upload',
      modeLabel: 'Upload mode',
      modeManual: 'Manual only',
      modeDeferred: 'On idle',
      modeRealtime: 'Every turn',
      descManual: 'Nothing is uploaded unless you trigger it.',
      descDeferred: 'Uploads after the session stays idle for 10 minutes; history is caught up at startup.',
      descRealtime: 'Uploads after every turn.',
      disabledNote: 'When enabled, session logs from non-official model channels are sent to DeepSeek.',
      uploadNow: 'Upload now',
      uploading: 'Uploading…',
      uploadHintManual: 'Switch to "Manual only" to use this button',
      noticeUploaded: 'Uploaded {sessions} session(s), {kb} KB.',
      noticeUploadedMore: ' {n} event(s) still pending — click Upload now again to continue.',
      noticeUpToDate: 'Already up to date — nothing to upload.',
      noticeCooldown: 'Just uploaded. Try again in {sec}s.',
      noticeDisabled: 'The plugin is off.',
      noticeNoKey: 'No API key configured.',
      noticeBusy: 'An upload is already running.',
      noticeOfficialOwned: '{n} session(s) have pending content owned by the built-in uploader. Check its switch in the built-in row above.',
      noticeBlocked: '{n} session(s) have an event larger than the size cap, so nothing was sent. Raise maxBytes or trim that event.',
      noticeError: 'Upload failed. See the host log.',
      noticeFailed: 'Upload failed for {n} session(s). See the host log.',
    };
    const zh = {
      title: '跨渠道会话日志上传',
      enable: '开启跨渠道上传',
      modeLabel: '上传模式',
      modeManual: '仅手动',
      modeDeferred: '收尾与空闲',
      modeRealtime: '每轮实时',
      descManual: '不点就不上传；插件加载后不产生任何请求。',
      descDeferred: '会话空闲 10 分钟后上传，应用启动时补传历史。',
      descRealtime: '每轮结束后立刻上传。',
      disabledNote: '开启后会把非官方渠道的会话日志发送到 DeepSeek。',
      uploadNow: '立即上传',
      uploading: '上传中…',
      uploadHintManual: '切到「仅手动」档后可用',
      noticeUploaded: '已上传 {sessions} 个会话，共 {kb} KB。',
      noticeUploadedMore: '还有 {n} 条待传，再点一次「立即上传」可继续。',
      noticeUpToDate: '当前已是最新，无需上传。',
      noticeCooldown: '刚上传过，{sec} 秒后可再试。',
      noticeDisabled: '插件未开启。',
      noticeNoKey: '未配置 API Key。',
      noticeBusy: '已有上传在进行中。',
      noticeOfficialOwned: '有 {n} 个会话的待传内容归内置插件上传，请检查上面官方那行的开关。',
      noticeBlocked: '有 {n} 个会话存在超过大小上限的单个事件，本次一个请求都没发。请调大上限或处理该事件。',
      noticeError: '上传失败，详情看宿主日志。',
      noticeFailed: '{n} 个会话上传失败，详情看宿主日志。',
    };

    /** 主题内的下拉：按钮 + 浮层，键盘可达（方向键 / 回车 / Esc）。 */
    function ModeSelect({ value, options, onChange, disabled, ariaLabel }) {
      const [open, setOpen] = React.useState(false);
      const [active, setActive] = React.useState(0);
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
      const current = options[currentIndex] ?? options[0];

      const choose = (option) => {
        setOpen(false);
        if (option && option.value !== value) onChange(option.value);
      };

      const onKeyDown = (event) => {
        if (disabled) return;
        if (!open) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setActive(currentIndex);
            setOpen(true);
          }
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => (index + 1) % options.length);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (index - 1 + options.length) % options.length);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose(options[active]);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
        } else if (event.key === 'Tab') {
          setOpen(false);
        }
      };

      return h('div', { className: 'sla-select', ref: rootRef, onKeyDown },
        h('button', {
          type: 'button',
          className: 'sla-trigger',
          disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => {
            if (disabled) return;
            setActive(currentIndex);
            setOpen((wasOpen) => !wasOpen);
          },
        },
          h('span', null, current?.label ?? ''),
          chevron(),
        ),
        open ? h('ul', { className: 'sla-menu', role: 'listbox', 'aria-label': ariaLabel },
          options.map((option, index) => h('li', {
            key: option.value,
            role: 'option',
            'aria-selected': option.value === value,
            'data-active': index === active ? 'true' : 'false',
            className: 'sla-option',
            onClick: () => choose(option),
            onMouseEnter: () => setActive(index),
          },
            h('span', null, option.label),
            option.value === value ? tick() : null,
          )),
        ) : null,
      );
    }

    /** 主题内的开关。 */
    function Toggle({ checked, disabled, ariaLabel, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'sla-switch',
        'aria-checked': checked,
        'aria-label': ariaLabel,
        disabled,
        onClick: () => { if (!disabled) onChange(!checked); },
      });
    }

    /** Host 返回码 → 一行提示。 */
    function describeResult(data, t) {
      switch (data?.code) {
        case 'uploaded': {
          const base = t('noticeUploaded')
            .replace('{sessions}', String(data.sessions ?? 0))
            .replace('{kb}', String(Math.max(1, Math.round((data.bytes ?? 0) / 1024))));
          const rest = Number(data.remaining ?? 0);
          return {
            tone: 'success',
            // 连接处的空格由文案模板负责：中文句号后不加空格，英文需要。
            text: rest > 0 ? base + t('noticeUploadedMore').replace('{n}', String(rest)) : base,
          };
        }
        case 'up-to-date':
          return { tone: 'info', text: t('noticeUpToDate') };
        case 'cooldown':
          return { tone: 'info', text: t('noticeCooldown').replace('{sec}', String(Math.max(1, Math.ceil((data.retryAfterMs ?? 0) / 1000)))) };
        case 'disabled':
          return { tone: 'error', text: t('noticeDisabled') };
        case 'no-key':
          return { tone: 'error', text: t('noticeNoKey') };
        case 'busy':
          return { tone: 'info', text: t('noticeBusy') };
        case 'blocked':
          return { tone: 'error', text: t('noticeBlocked').replace('{n}', String(data.blocked ?? 0)) };
        case 'official-owned':
          return { tone: 'info', text: t('noticeOfficialOwned').replace('{n}', String(data.officialOwned ?? 0)) };
        case 'failed':
          return { tone: 'error', text: t('noticeFailed').replace('{n}', String(data.failures ?? 0)) };
        default:
          return { tone: 'error', text: t('noticeError') };
      }
    }

    function SettingsRow(props) {
      const { useConfig, setMode, setEnabled, t } = props;
      const snapshot = typeof useConfig === 'function' ? useConfig((value) => value) : null;
      const config = snapshot?.value ?? {};
      const ready = snapshot?.status === 'ready' && snapshot?.writable !== false;
      const enabled = config.enabled === true;
      const mode = typeof config.mode === 'string' ? config.mode : 'deferred';
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      React.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(timer);
      }, [notice ? notice.text : null]);

      const uploadNow = async () => {
        if (busy) return;
        setBusy(true);
        setNotice(null);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 120000) : null;
        try {
          const response = await fetch('/__dsh-session-sync/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-sync': '1' },
            body: '{}',
            signal: controller?.signal,
          });
          let data = null;
          try {
            data = await response.json();
          } catch {
            data = { code: 'error' };
          }
          setNotice(describeResult(data, t));
        } catch {
          setNotice({ tone: 'error', text: t('noticeError') });
        } finally {
          if (timer !== null) clearTimeout(timer);
          setBusy(false);
        }
      };

      const manualOnly = mode === 'manual';
      const canUpload = ready && enabled && manualOnly && !busy;
      const descKey = mode === 'manual' ? 'descManual' : mode === 'realtime' ? 'descRealtime' : 'descDeferred';

      const options = [
        { value: 'manual', label: t('modeManual') },
        { value: 'deferred', label: t('modeDeferred') },
        { value: 'realtime', label: t('modeRealtime') },
      ];

      return h('div', { className: 'sla-row' },
        h('div', { className: 'sla-left' },
          h('div', { className: 'sla-title' }, t('title')),
          h('div', { className: 'sla-desc' }, t(descKey)),
          enabled ? null : h('div', { className: 'sla-note' }, t('disabledNote')),
          h('div', { className: 'sla-actions' },
            h('button', {
              type: 'button',
              className: 'sla-upload',
              disabled: !canUpload,
              title: manualOnly ? undefined : t('uploadHintManual'),
              onClick: uploadNow,
            }, busy ? t('uploading') : t('uploadNow')),
            notice ? h('span', { className: 'sla-notice', 'data-tone': notice.tone }, notice.text) : null,
          ),
        ),
        h('div', { className: 'sla-right' },
          h(ModeSelect, {
            value: mode,
            options,
            disabled: !ready,
            ariaLabel: t('modeLabel'),
            onChange: (next) => setMode(next),
          }),
          h(Toggle, {
            checked: enabled,
            disabled: !ready,
            ariaLabel: t('enable'),
            onChange: (next) => setEnabled(next),
          }),
        ),
      );
    }

    const inject = ['slots', 'locale', 'configForms'];

    function apply(ctx) {
      const locale = 'settings.sessionLogAnywhere';
      const namespace = 'dsh-session-sync';
      ctx.effect(() => ctx.locale.register(locale, { en, zh }));

      const form = ctx.configForms.get(namespace);
      const face = () => ({
        hooks: { config: form },
        setMode: (mode) => { Promise.resolve(form.set('mode', mode)).catch(() => {}); },
        setEnabled: (enabled) => { Promise.resolve(form.set('enabled', enabled)).catch(() => {}); },
      });

      // 等 Host 把这条 entry 的 Config 服务出来再挂行，避免配置还没就绪时渲染出空控件。
      ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: namespace,
        order: 91,
        locale,
        inject: face,
      }, SettingsRow))));
    }

    return { inject, apply };
  },
});
