window.__ModuleLoader__.load({
  id: '@local/side-chat',
  factory(require) {
    const React = require('react');
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const NS = 'sidechat';
    const TAB_ID = '@local/side-chat/chat';
    const NEW_ID = '@local/side-chat/new';
    const KIND = 'sidechat';
    const NEW_KIND = 'sidechat-new';
    const PREFIX = 'dsh-resource://sidechat/session/';
    const records = new Map();
    const listeners = new Set();
    const approved = new Set();
    let clientId;
    let lifetime;
    const zh = {
      title: '侧聊', numbered: '侧聊 {index}', new: '新建侧聊',
      description: '从当前对话创建临时分支，独立提问，不打断主聊',
      empty: '侧聊是临时对话，关闭标签或应用后将消失。',
      loading: '正在创建侧聊…', expired: '这段临时侧聊已结束，无法恢复。',
      retry: '重试', error: '侧聊操作失败：{message}',
      closeTitle: '关闭侧聊？', closeDescription: '这段侧聊将消失，无法找回。正在进行的任务也会停止。',
      close: '关闭侧聊', cancel: '取消', skip: '不再询问', closing: '正在关闭…',
      unread: '有未读回复', running: '正在回复', failed: '操作失败',
    };
    const en = {
      title: 'Side chat', numbered: 'Side chat {index}', new: 'New side chat',
      description: 'Start a temporary fork without interrupting the main chat',
      empty: 'Side chats are temporary and disappear when you close the tab or app.',
      loading: 'Starting side chat…', expired: 'This temporary side chat has expired and cannot be recovered.',
      retry: 'Retry', error: 'Side chat failed: {message}',
      closeTitle: 'Close side chat?', closeDescription: 'This side chat will be gone and cannot be recovered. Running work will stop.',
      close: 'Close side chat', cancel: 'Cancel', skip: 'Don’t ask again', closing: 'Closing…',
      unread: 'Unread response', running: 'Responding', failed: 'Failed',
    };
    let root;
    let t;

    function update(id, patch) {
      const previous = records.get(id);
      if (previous === undefined) {
        return;
      }
      if (Object.keys(patch).every((key) => previous[key] === patch[key])) {
        return;
      }
      records.set(id, { ...previous, ...patch });
      for (const listener of listeners) {
        listener();
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useRecord(id) {
      return React.useSyncExternalStore(subscribe, () => records.get(id));
    }

    function addressOf(childId, parentSessionId) {
      return `${PREFIX}${encodeURIComponent(childId)}?parent=${encodeURIComponent(parentSessionId)}`;
    }

    function parseAddress(value) {
      let url;
      try {
        url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const parentSessionId = url.searchParams.get('parent');
        if (url.protocol === 'dsh-resource:' && url.hostname === 'sidechat' && parts.length === 2 && parts[0] === 'session' && parentSessionId) {
          return { childId: decodeURIComponent(parts[1]), parentSessionId };
        }
      } catch (_error) {
        return undefined;
      }
      return undefined;
    }

    async function call(endpoint, payload, signal) {
      const result = await root.connection.rpc.call('/side-chat', endpoint, payload, signal);
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }
      return result.value;
    }

    function notify(sessionId, error) {
      const context = root.sessions.scope(sessionId);
      if (context === undefined) {
        console.warn('[side-chat] operation failed after its parent view was released', error);
        return;
      }
      context.get('conversation').input.for(context).notify('error', t('error', { message: error.message }));
    }

    function connectLifetime() {
      const controller = new AbortController();
      const owner = { controller, clientId: crypto.randomUUID() };
      clientId = owner.clientId;
      lifetime = owner;
      const expire = (message) => {
        if (lifetime !== owner || controller.signal.aborted) {
          return;
        }
        lifetime = undefined;
        for (const id of records.keys()) {
          update(id, { expired: true, error: message });
        }
      };
      void call('hold', { clientId: owner.clientId }, controller.signal)
        .then(() => expire(t('expired')))
        .catch((error) => expire(error.message));
    }

    function openSideChat(parentSessionId) {
      root.sidebarRight.openTabIn(parentSessionId, NEW_KIND);
    }

    async function startSideChat(parentSessionId, openResource, signal) {
      if (lifetime === undefined) {
        connectLifetime();
      }
      const requestId = crypto.randomUUID();
      let childId;
      try {
        const opened = await call('open', { parentSessionId, requestId }, signal);
        signal.throwIfAborted();
        childId = opened.childId;
        records.set(childId, {
          ...opened, parentSessionId, title: opened.index === 1 ? t('title') : t('numbered', { index: opened.index }),
          running: false, unread: false, hasContent: false, visible: false, closeState: null, error: null,
        });
        const address = addressOf(childId, parentSessionId);
        openResource(address, { replaceTab: true });
      } catch (error) {
        if (signal.aborted) {
          await call('cancel-open', { requestId }).catch((cleanupError) => notify(parentSessionId, cleanupError));
          return;
        }
        if (childId !== undefined) {
          await call('close', { childId });
          records.delete(childId);
        }
        notify(parentSessionId, error);
        throw error;
      }
    }

    function waitForAbort(signal) {
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    }

    function skipConfirmation() {
      return localStorage.getItem('sidechat.skip-close-confirmation') === 'true';
    }

    async function finishClose(childId, skip) {
      const record = records.get(childId);
      update(childId, { closeState: record.closeState === 'silent-closing' ? 'silent-closing' : 'closing', error: null });
      try {
        await call('close', { childId }).catch((error) => {
          // Absence is a completed close, including expiry during the dialog.
          // Other failures still preserve the tab for cleanup and retry.
          if (error.code !== 'side-chat/expired') {
            throw error;
          }
        });
        if (skip) {
          localStorage.setItem('sidechat.skip-close-confirmation', 'true');
        }
        update(childId, { closed: true, expired: true, closeState: null, error: t('expired') });
        approved.add(childId);
        root.sidebarRight.closeIn(record.parentSessionId, record.tabId);
      } catch (error) {
        update(childId, { closeState: 'confirm', error: error.message });
      }
    }

    function beforeClose(_parentId, tab) {
      const parsed = parseAddress(tab.contentId);
      if (parsed === undefined || !records.has(parsed.childId)) {
        return;
      }
      if (approved.delete(parsed.childId)) {
        return;
      }
      const record = records.get(parsed.childId);
      if (record.closed === true) {
        return;
      }
      if (record.closeState === 'closing' || record.closeState === 'silent-closing') {
        throw new Error(t('closing'));
      }
      if (!record.hasContent || skipConfirmation()) {
        update(parsed.childId, { tabId: tab.id, closeState: 'silent-closing' });
        void finishClose(parsed.childId, false);
      } else {
        update(parsed.childId, { tabId: tab.id, closeState: 'confirm' });
      }
      // This is the host's supported cancellation contract. Commit the actual
      // close only after the dialog and backend cleanup have succeeded.
      throw new Error(t('closeTitle'));
    }

    function CloseDialog({ childId, record }) {
      const [skip, setSkip] = React.useState(false);
      const busy = record.closeState === 'closing';
      const cancel = () => {
        if (!busy) {
          update(childId, { closeState: null, error: null });
        }
      };
      return h(Modal, {
        open: true, title: t('closeTitle'), description: t('closeDescription'), closeLabel: t('cancel'), onClose: cancel,
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: cancel }, t('cancel')),
          h(Button, { variant: 'primary', disabled: busy, onClick: () => { void finishClose(childId, skip); } }, t(busy ? 'closing' : 'close'))),
      },
      record.error === null ? null : h('p', { role: 'alert' }, record.error),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
        h('input', { type: 'checkbox', checked: skip, disabled: busy, onChange: (event) => setSkip(event.target.checked) }), t('skip')));
    }

    function FixedChatView(props) {
      const running = props.useSession((value) => value.running);
      const attempted = props.useSession((value) => value.promptAttempted);
      const childId = props.useSession((value) => value.sessionId);
      const record = useRecord(childId);
      React.useEffect(() => {
        if (record !== undefined) {
          update(childId, {
            running, hasContent: record.hasContent || attempted,
            unread: record.visible ? false : record.unread || (record.running && !running),
          });
        }
      }, [childId, running, attempted, record?.visible]);
      return h(React.Fragment, null,
        !attempted ? h('div', { style: { flex: '1 1 auto', display: 'grid', placeContent: 'center', textAlign: 'center', padding: 24 }, 'data-sidechat-empty': '' },
          h('strong', null, t('title')), h('p', null, t('empty'))) : props.renderSlot('conversation.session', { view: 'chat' }));
    }

    function SideChatConversation(props) {
      const openState = props.useSession((value) => value.openState);
      return props.renderFactorySlot('conversation.content', {
        variant: 'embedded', phase: openState === 'cold' || openState === 'loading' ? 'settling' : 'active', hero: false,
      }, { slots: { views: FixedChatView } });
    }

    const LAYOUT_CSS = '[data-side-chat]{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;min-height:0}'
      + '[data-side-chat] [data-slot="sidechat.conversation"]{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}'
      + '[data-side-chat] [data-conversation-content]{flex:1;min-width:0;min-height:0}';

    function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
      const { tab } = useTabInfo();
      const resource = useResource(tab.contentId);
      const parsed = parseAddress(tab.contentId);
      const record = useRecord(parsed.childId);
      React.useEffect(() => {
        update(parsed.childId, { visible: tab.visible, tabId: tab.id, ...(tab.visible ? { unread: false } : {}) });
      }, [parsed.childId, tab.visible, tab.id]);
      const value = resource.value;
      let content;
      if (resource.status === 'failed' || record?.expired === true) {
        content = h('div', { role: 'alert', style: { padding: 24 } },
          h('p', null, resource.status === 'failed' ? resource.failure.message : record.error),
          h(Button, { variant: 'outline', onClick: () => tab.actions.openTab(NEW_KIND, { replaceTab: true }) }, t('new')));
      } else if (value === undefined) {
        content = h('div', { role: 'status', style: { padding: 24 } }, t('loading'));
      } else {
        const selectors = value.inheritedTurns.map((turn) => `[data-side-chat="${value.childId}"] [data-chat-turn="${turn}"]`);
        const css = selectors.length === 0 ? '' : `${selectors.join(',')}{display:none}`;
        content = h(React.Fragment, null, h('style', null, css), h(SessionProvider, { session: value.reference }, renderSlot('sidechat.conversation', {})));
      }
      return h('div', { 'data-side-chat': parsed.childId }, h('style', null, LAYOUT_CSS), content,
        record?.closeState === 'confirm' || record?.closeState === 'closing' ? h(CloseDialog, { childId: parsed.childId, record }) : null);
    }

    function SideChatTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      const parsed = parseAddress(tab.contentId);
      const record = useRecord(parsed.childId);
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        record?.running ? h('span', { role: 'status', 'aria-label': t('running') }, '◌') : null,
        record?.title ?? t('title'),
        record?.unread ? h('span', { role: 'status', 'aria-label': t('unread'), style: { color: 'var(--dsw-alias-state-business-primary)' } }, '●') : null);
    }

    function NewSideChatTab({ useTabInfo, useSession }) {
      const { tab } = useTabInfo();
      const parentId = useSession((value) => value.sessionId);
      const [error, setError] = React.useState(null);
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        void startSideChat(parentId, tab.actions.openResource, tab.signal).catch((error) => setError(error.message));
      }, [parentId, tab.id, attempt]);
      return h('div', { role: error === null ? 'status' : 'alert', style: { padding: 24 } }, error ?? t('loading'),
        error === null ? null : h(Button, { variant: 'outline', onClick: () => { setError(null); setAttempt(attempt + 1); } }, t('retry')));
    }

    function SideChatIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2.2 }),
        h('path', { d: 'M9.5 2v12M11.2 6h1.6M12 5.2v1.6' }));
    }

    function registerHeaderMenu(ctx) {
      const name = 'conversation.session.header.utilities';
      let source;
      let remove = () => {};
      const reconcile = () => {
        const next = ctx.slots.entries(name).find((entry) => entry.options.id === 'session-log-download' && (entry.options.priority ?? 0) === 0);
        if (source === next) {
          return;
        }
        remove();
        source = next;
        if (source === undefined) {
          return;
        }
        // Shadow the existing slot cell, preserving its injected controller and
        // native Menu, Button, download dialog, feedback and keyboard behavior.
        // The host menu has no item slot in this DSH release.
        const native = source;
        function SideChatHeaderMenu(props) {
          const tree = native.component(props);
          if (records.has(props.sessionId)) {
            return tree;
          }
          const [menu, ...rest] = React.Children.toArray(tree.props.children);
          const extended = React.cloneElement(menu, {
            items: [{ id: 'sidechat.new', label: t('new'), icon: h(SideChatIcon) }, ...menu.props.items],
            onSelect: (id) => {
              if (id === 'sidechat.new') {
                menu.props.onClose();
                openSideChat(props.sessionId);
              } else {
                menu.props.onSelect(id);
              }
            },
          });
          return React.cloneElement(tree, undefined, extended, ...rest);
        }
        remove = ctx.slots.register({
          name, ...native.options, priority: -1,
          locale: native.locale, inject: native.inject,
          ...(native.store === undefined ? {} : { store: native.store }),
        }, SideChatHeaderMenu);
      };
      const stop = ctx.slots.subscribe(name, reconcile);
      reconcile();
      return () => { stop(); remove(); };
    }

    function registerTab(ctx) {
      ctx.effect(() => ctx.resources.register({
        protocol: 'sidechat',
        async *open(address, options) {
          const parsed = parseAddress(address);
          if (parsed === undefined) {
            throw new Error(`Invalid side chat address: ${address}`);
          }
          let value;
          const holderId = clientId;
          try {
            value = await call('attach', { ...parsed, clientId: holderId });
          } catch (error) {
            if (error.code === 'side-chat/expired') {
              update(parsed.childId, { closed: true, expired: true, closeState: null, error: error.message });
            }
            yield { ok: false, error: { code: error.code ?? 'side-chat/unavailable', message: error.message, details: {} } };
            return;
          }
          if (!records.has(parsed.childId)) {
            records.set(parsed.childId, { ...parsed, ...value, title: value.index === 1 ? t('title') : t('numbered', { index: value.index }), running: false, unread: false, hasContent: false, visible: false, closeState: null, error: null });
          }
          // `attach` authenticated this exact Host identity. Bootstrap its scope
          // directly: temporary Sessions deliberately do not enter the catalog.
          const authority = ctx.sessions.retainAgentScope(parsed.childId);
          let reference;
          try {
            reference = ctx.sessions.retain(parsed.childId, { source: 'sideChat', signal: options.signal });
          } finally {
            authority.release();
          }
          try {
            yield { ok: true, value: { ...parsed, ...value, reference } };
            await waitForAbort(options.signal);
          } finally {
            reference.release();
            records.delete(parsed.childId);
            await call('release', { childId: parsed.childId, clientId: holderId }).catch((error) => {
              if (error.code !== 'side-chat/expired') {
                console.warn('[side-chat] failed to release temporary chat', error);
              }
            });
          }
        },
      }), 'side-chat: transient resources');
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => registerHeaderMenu(ctx)), 'side-chat: native header menu');
      ctx.effect(() => root.sidebarRight.registerCloseHandler(KIND, beforeClose), 'side-chat: close contract');
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID, kind: KIND, patterns: [`${PREFIX}**`], priority: 'extension', keepMounted: true,
        canOpen: (address) => parseAddress(address) !== undefined,
        title: (address) => records.get(parseAddress(address).childId)?.title ?? t('title'),
      }), 'side-chat: tab type');
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: NEW_ID, kind: NEW_KIND, priority: 'extension', multiple: true, title: () => t('new'),
        guide: [{ id: 'new', commandId: 'sidechat.new', order: 25, title: () => t('new'), description: () => t('description') }],
      }), 'side-chat: new tab entry');
      for (const [name, key, component, children] of [
        ['sidebar.right.pane.tab', TAB_ID, SideChatTab, { 'sidechat.conversation': { kind: 'single', scope: 'session' } }],
        ['sidebar.right.pane.tab.title', TAB_ID, SideChatTitle],
        ['sidebar.right.pane.tab', NEW_ID, NewSideChatTab],
        ['sidechat.conversation', TAB_ID, SideChatConversation],
      ]) {
        ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, key, ...(children === undefined ? {} : { children }) }, component)), `side-chat: ${name}`);
      }
    }

    return {
      inject: ['sessions', 'slots', 'locale', 'sidebarRight', 'connection'],
      apply(ctx) {
        root = ctx;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries');
        t = ctx.locale.bind(NS);
        ctx.effect(() => {
          connectLifetime();
          return () => lifetime?.controller.abort();
        }, 'side-chat: window lifetime');
        ctx.inject(['resources', 'sidebarRightTabs'], registerTab);
        ctx.inject(['commandUi'], (scope) => {
          scope.effect(() => scope.get('commandUi').register({
            name: 'side', label: () => t('new'), description: () => t('description'),
            available: (session) => !records.has(session.sessionId),
            ui: { kind: 'action', run: (session) => { openSideChat(session.sessionId); } },
          }), 'side-chat: /side');
        });
        ctx.inject(['shortcuts'], (scope) => {
          scope.effect(() => scope.shortcuts.register({
            id: 'sidechat.new', label: () => t('new'), aliases: ['side chat'],
            defaults: {
              'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
              'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
            },
            regions: ['page', 'editable', 'terminal'], modals: [],
            resolve: () => {
              const parent = root.sidebarRight.mounted.getSnapshot();
              return parent === undefined ? { status: 'blocked', reason: t('description') } : { status: 'handled', run: () => { openSideChat(parent); } };
            },
          }), 'side-chat: shortcut');
        });
      },
    };
  },
});
