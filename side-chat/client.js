window.__ModuleLoader__.load({
  id: '@local/side-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'sidechat';
    /** Tab-type identity: unique across every sidebar tab registration. */
    const TAB_ID = '@local/side-chat/chat';
    /** Tab kind and client-resource protocol this plugin owns. */
    const KIND = 'sidechat';
    const PROTOCOL = 'sidechat';
    /** Resource address prefix; the side session id rides the path. */
    const ADDRESS_PREFIX = 'dsh-resource://sidechat/session/';
    /** Host channel that attaches the main conversation's hidden context. */
    const CHANNEL = '/side-chat';
    /** Side Session ids currently hosted by a tab, mapped to their owner. */
    const sideParents = new Map();
    const starting = new Set();

    const zh = {
      'tab.title': '侧边栏会话',
      'command.label': '侧边栏会话',
      'command.description': '在右侧栏分叉当前对话，提问前同步主聊新增记录；关闭标签后归档',
      'error.start': '无法打开侧边栏会话：{message}',
      'error.attach': '侧聊上下文未就绪，暂时无法提问。请关闭标签后重新打开：{message}',
    };

    const en = {
      'tab.title': 'Side chat',
      'command.label': 'Side chat',
      'command.description': 'Fork this conversation in the right Sidebar and sync new parent records before each question; close the tab to archive',
      'error.start': 'Cannot open the side chat: {message}',
      'error.attach': 'Side chat context is not ready. Close the tab and reopen it before asking: {message}',
    };

    /**
     * Compose one side conversation's client-resource address.
     * @param sessionId - side Session identity.
     * @param parentSessionId - conversation this side chat belongs to.
     * @returns canonical `dsh-resource://` address.
     */
    function addressOf(sessionId, parentSessionId) {
      return `${ADDRESS_PREFIX}${encodeURIComponent(sessionId)}?parent=${encodeURIComponent(parentSessionId)}`;
    }

    /**
     * Recover the side Session identity and its owner from one address.
     * @param value - possible side conversation address.
     * @returns the identities, or undefined for another or malformed address.
     */
    function parseAddress(value) {
      let url;
      try {
        url = new URL(value);
      } catch (_invalidUrl) {
        return undefined;
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sidechat') {
        return undefined;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'session') {
        return undefined;
      }
      const parentSessionId = url.searchParams.get('parent');
      if (parentSessionId === null || parentSessionId === '') {
        return undefined;
      }
      try {
        return {
          sessionId: decodeURIComponent(parts[1]),
          parentSessionId,
        };
      } catch (_invalidEncoding) {
        return undefined;
      }
    }

    /**
     * Call one endpoint on the plugin's Host channel.
     * @param ctx - client context carrying connection.
     * @param endpoint - `attach` or `detach`.
     * @param payload - endpoint payload.
     * @returns the endpoint value.
     */
    async function callChannel(ctx, endpoint, payload) {
      const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    }

    /**
     * Resolve a resource stream's completion when its last holder releases it.
     * @param signal - stream abort signal.
     * @returns a promise resolved on abort.
     */
    function waitForAbort(signal) {
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        }, { once: true });
      });
    }

    /**
     * Report a command failure through the composer's notice channel.
     * @param ctx - client context carrying the sessions service.
     * @param sessionId - offending Session identity.
     * @param text - localized failure text.
     */
    function notifyComposer(ctx, sessionId, text) {
      try {
        const actx = ctx.sessions.scope(sessionId);
        const conversation = actx?.get('conversation');
        conversation?.input.for(actx).notify('error', text);
      } catch (error) {
        console.warn('[side-chat] failed to report the side-chat failure', error);
      }
    }

    /**
     * Open one side conversation: create the ordinary Session, attach the main
     * conversation's hidden context, and open (or focus) its tab.
     * @param ctx - client context carrying sessions, connection, and sidebar navigation.
     * @param parentSessionId - conversation the command ran in.
     * @param t - `sidechat` translator.
     */
    async function startSideChat(ctx, parentSessionId, t) {
      if (starting.has(parentSessionId)) {
        return;
      }
      const existing = sideParents.get(parentSessionId);
      if (existing !== undefined && ctx.sessions.list.getSnapshot().byId[existing] !== undefined) {
        ctx.sidebarRight.openResource(addressOf(existing, parentSessionId), {
          kind: KIND,
          preferNewPane: true,
        });
        return;
      }
      starting.add(parentSessionId);
      try {
        const { childId } = await callChannel(ctx, 'open', { parentSessionId });
        sideParents.set(parentSessionId, childId);
        try {
          await ctx.remote.session.rename({ sessionId: childId, title: t('tab.title') });
        } catch (error) {
          console.warn('[side-chat] failed to title the side conversation', error);
        }
        ctx.sidebarRight.openResource(addressOf(childId, parentSessionId), {
          kind: KIND,
          preferNewPane: true,
        });
      } catch (error) {
        notifyComposer(ctx, parentSessionId, t('error.start', {
          message: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        starting.delete(parentSessionId);
      }
    }

    /**
     * Render one explicitly provided side Session's Chat-shaped Conversation.
     * A blank Session renders no View area at all, which would leave the resident
     * composer pinned to the top of the pane; hold the scrollport open until the
     * first message so the composer sits at the bottom like the main column.
     * @param props - View factory props.
     * @returns a flexible filler or the active Chat View.
     */
    function FixedChatView(props) {
      const blank = props.useSession((value) => value.blank);
      if (blank) {
        return h('div', { style: { flex: '1 1 auto', minHeight: 0 } });
      }
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }));
    }

    /**
     * Render one side Session's Conversation body. The side conversation always
     * opens on its own transcript and resident composer, never the new-session
     * Hero.
     * @param props - Session standard props plus the Conversation factory renderer.
     * @returns the embedded Conversation content.
     */
    function SideChatConversation(props) {
      const { useSession, renderFactorySlot } = props;
      const openState = useSession((value) => value.openState);
      const phase = openState === 'cold' || openState === 'loading' ? 'settling' : 'active';
      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase,
        hero: false,
      }, { slots: { views: FixedChatView } });
    }

    /**
     * Bind one side conversation resource around the Conversation slot.
     * @param props - Sidebar tab standard props.
     * @returns the tab body.
     */
    /** Layout contract for the sidebar host: the embedded Conversation needs a
     * full-height flex column between the tab body and its own flex body, or an
     * empty transcript leaves the composer at the top of the pane. */
    const TAB_LAYOUT_CSS = '[data-side-chat]{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;min-height:0}'
      + '[data-side-chat] [data-slot="sidechat.conversation"]{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}'
      + '[data-side-chat] [data-conversation-content]{flex:1;min-width:0;min-height:0}';

    function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
      const { tab } = useTabInfo();
      const resource = useResource(tab.contentId);
      const value = resource.value;
      if (resource.status === 'failed') {
        return h('div', { role: 'alert', style: { padding: 16 } }, resource.failure.message);
      }
      // Native forks retain their original roles/media in model history. Only
      // their inherited turns are omitted from this sidebar's Chat presentation.
      const inheritedSelectors = value?.inheritedTurns.map((turn) => `[data-side-chat="${value.sessionId}"] [data-chat-turn="${turn}"]`) ?? [];
      const inheritedCss = inheritedSelectors.length === 0 ? '' : `${inheritedSelectors.join(',')}{display:none}`;
      return h('div', { 'data-side-chat': value?.sessionId ?? '' }, h('style', null, TAB_LAYOUT_CSS + inheritedCss), value === undefined ? null : h(SessionProvider, {
        session: value.reference,
      }, renderSlot('sidechat.conversation', {})));
    }

    /**
     * Register the side conversation resource, its tab type, and its body.
     * @param ctx - injected client scope carrying `resources` and `sidebarRightTabs`.
     * @param root - client root context carrying connection and workspace actions.
     * @param t - `sidechat` translator.
     */
    function registerSideChatTab(ctx, root, t) {
      ctx.effect(() => ctx.resources.register({
        protocol: PROTOCOL,
        async *open(address, options) {
          const parsed = parseAddress(address);
          if (parsed === undefined) {
            throw new Error(`side-chat: invalid side conversation address "${address}"`);
          }
          let attachment;
          try {
            await root.uiWorkspace.unarchiveSession(parsed.sessionId);
            attachment = await callChannel(root, 'attach', {
              parentSessionId: parsed.parentSessionId,
              childId: parsed.sessionId,
            });
          } catch (error) {
            yield { ok: false, error: {
              code: 'side-chat/context-unavailable',
              message: t('error.attach', { message: error instanceof Error ? error.message : String(error) }),
              details: {},
            } };
            return;
          }
          sideParents.set(parsed.parentSessionId, parsed.sessionId);
          const reference = ctx.sessions.retain(parsed.sessionId, {
            source: 'sideChat',
            signal: options.signal,
          });
          try {
            yield { ok: true, value: { ...parsed, reference, inheritedTurns: attachment.inheritedTurns } };
            await waitForAbort(options.signal);
          } finally {
            reference.release();
            if (sideParents.get(parsed.parentSessionId) === parsed.sessionId) {
              sideParents.delete(parsed.parentSessionId);
            }
            callChannel(root, 'detach', { childId: parsed.sessionId })
              .finally(() => root.uiWorkspace.archiveSession(parsed.sessionId, { stopActivity: true }))
              .catch((error) => {
                console.warn('[side-chat] failed to hide the closed side conversation', error);
              });
          }
        },
      }), 'side-chat: side conversation resources');

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        patterns: [`${ADDRESS_PREFIX}**`],
        priority: 'extension',
        canOpen: (address) => parseAddress(address) !== undefined,
        title: () => t('tab.title'),
      }), 'side-chat: sidebar tab type');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        children: {
          'sidechat.conversation': { kind: 'single', scope: 'session' },
        },
      }, SideChatTab)), 'side-chat: sidebar tab body');

      ctx.effect(() => ctx.slots.inject('sidechat.conversation', () => ctx.slots.register({
        name: 'sidechat.conversation',
      }, SideChatConversation)), 'side-chat: sidebar conversation');
    }

    /** Command-menu glyph; the row renders it at its own size. */
    function SideChatIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('rect', { key: 'main', x: 1, y: 2, width: 9.5, height: 12, rx: 2, fill: 'currentColor', opacity: 0.9 }),
        h('rect', { key: 'side', x: 11.5, y: 2, width: 3.5, height: 12, rx: 1.5, fill: 'currentColor', opacity: 0.45 }),
      ]);
    }

    /**
     * Register the `/side` command: a client action that opens a side conversation.
     * @param ctx - injected client scope carrying `commandUi`.
     * @param root - client root context carrying sessions and connection.
     * @param t - `sidechat` translator.
     */
    function registerCommand(ctx, root, t) {
      const command = ctx.get('commandUi');
      ctx.effect(() => command.register({
        name: 'side',
        label: () => t('command.label'),
        description: () => t('command.description'),
        icon: SideChatIcon,
        /** Side sessions never offer another side session. */
        available: (session) => ![...sideParents.values()].includes(session.sessionId),
        ui: {
          kind: 'action',
          run: (session) => {
            void startSideChat(root, session.sessionId, t);
          },
        },
      }), 'side-chat: /side command');
    }

    return {
      inject: ['sessions', 'slots', 'locale', 'sidebarRight', 'uiWorkspace', 'connection', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
          registerSideChatTab(scope, ctx, t);
        });
        ctx.inject(['commandUi'], (scope) => {
          registerCommand(scope, ctx, t);
        });
      },
    };
  },
});
