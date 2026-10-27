import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const address = (id = 'child-1') => `dsh-resource://sidechat/session/${id}?parent=parent`

function fixture(override) {
  let bundle
  let next = 0
  const events = []
  const components = new Map()
  const definitions = new Map()
  const storage = new Map()
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children }, children }),
    cloneElement: (tree, props, ...children) => ({ ...tree, props: { ...tree.props, ...props, ...(children.length === 0 ? {} : { children }) }, ...(children.length === 0 ? {} : { children }) }),
    Children: { toArray: (children) => Array.isArray(children) ? children : [children] },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: (effect) => effect(),
    useLayoutEffect() {},
    useRef: () => ({ current: { showModal() {} } }),
    useState: (initial) => [initial, () => {}],
  }
  const slotEntries = [{
    options: { id: 'session-log-download' }, locale: 'native-menu',
    inject: () => ({}),
    component: () => react.createElement('fragment', null,
      react.createElement('native-menu', { items: [{ id: 'download' }, { id: 'feedback' }], onClose: () => events.push({ method: 'dismiss-menu' }), onSelect: (id) => events.push({ method: id }) }),
      react.createElement('native-download-dialog')),
  }]
  const ctx = {
    effect: (effect) => effect(),
    inject: (_services, callback) => callback(ctx),
    get: (name) => ctx[name],
    locale: { register() {}, bind: () => (key, values = {}) => `${key}${values.index ?? ''}${values.message ?? ''}` },
    commandUi: { register: (value) => { ctx.command = value } },
    resources: { register: (value) => { ctx.resource = value } },
    sidebarRightTabs: { register: (value) => definitions.set(value.kind, value) },
    shortcuts: { register: (value) => { ctx.shortcut = value } },
    slots: {
      inject: (_name, effect) => effect(),
      entries: () => slotEntries,
      subscribe: () => () => {},
      register: (definition, component) => {
        components.set(`${definition.name}:${definition.key ?? definition.id}`, component)
        return () => {}
      },
    },
    connection: { rpc: { call: async (_channel, method, payload, signal) => {
      events.push({ method, payload })
      if (method === 'hold') {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      const result = override?.(method, payload)
      if (result !== undefined) {
        return result
      }
      if (method === 'open') {
        next++
        return { ok: true, value: { childId: `child-${next}`, index: next, inheritedTurns: [1, 2] } }
      }
      return { ok: true, value: { childId: payload.childId, index: 1, inheritedTurns: [1, 2] } }
    } } },
    sessions: {
      retainAgentScope: () => ({ release() {} }),
      retain: () => ({ release: () => events.push({ method: 'release' }) }),
      scope: () => ({ get: () => ({ input: { for: () => ({ notify: (_kind, text) => events.push({ method: 'notice', text }) }) } }) }),
    },
    sidebarRight: {
      mounted: { getSnapshot: () => 'parent' },
      openResourceIn: (parentId, contentId) => events.push({ method: 'tab', parentId, contentId }),
      openTabIn: (parentId) => {
        events.push({ method: 'pending-tab' })
        components.get('sidebar.right.pane.tab:@local/side-chat/new')({
          useSession: (select) => select({ sessionId: parentId }),
          useTabInfo: () => ({ tab: { id: 'loading-tab', signal: new AbortController().signal, actions: { openResource: (contentId, options) => events.push({ method: 'tab', parentId, contentId, options }) } } }),
        })
      },
      registerCloseHandler: (_kind, handler) => { ctx.beforeClose = handler },
      closeIn: (parentId, id) => {
        ctx.beforeClose(parentId, { id, contentId: address() })
        events.push({ method: 'closed' })
      },
    },
  }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { bundle = value } } },
    URL, console, AbortController, crypto: { randomUUID },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { body: {} },
  })
  bundle.factory((name) => name === 'react' ? react : { Button: 'native-button', Modal: 'native-modal' }).apply(ctx)
  const component = (name, key = '@local/side-chat/chat') => components.get(`${name}:${key}`)
  const props = (resource) => ({
    useTabInfo: () => ({ tab: { id: 'tab-1', contentId: address(), visible: true, actions: {} } }),
    useResource: () => resource,
    SessionProvider: 'native-session-provider',
    renderSlot: () => 'native-conversation',
  })
  return { ctx, events, definitions, component, props }
}

async function open(f) {
  f.ctx.command.ui.run({ sessionId: 'parent' })
  await tick()
}

test('each invocation creates a distinct numbered side chat; transport retries carry unique identities', async () => {
  const f = fixture()
  await Promise.all([open(f), open(f)])
  const opens = f.events.filter((event) => event.method === 'open')
  assert.equal(opens.length, 2)
  assert.notEqual(opens[0].payload.requestId, opens[1].payload.requestId)
  assert.equal(f.events.filter((event) => event.method === 'tab').length, 2)
  const title = f.component('sidebar.right.pane.tab.title')({ useTabInfo: () => ({ tab: { contentId: address('child-2') } }) })
  assert.equal(title.children[1], 'numbered2')
  assert.equal(f.ctx.command.available({ sessionId: 'child-1' }), false)
  assert.equal(f.definitions.get('sidechat').keepMounted, true)
  assert.equal(f.definitions.get('sidechat-new').multiple, true)
  assert.equal(f.definitions.get('sidechat-new').guide.length, 1)
  assert.ok(f.component('conversation.session.header.utilities', 'session-log-download'))
  assert.equal(f.ctx.shortcut.resolve().status, 'handled')
})

test('native composer is retained, inherited turns are hidden, and the lifetime lease is aborted on release', async () => {
  const f = fixture()
  await open(f)
  const abort = new AbortController()
  const stream = f.ctx.resource.open(address(), { signal: abort.signal })
  const frame = (await stream.next()).value
  assert.equal(frame.ok, true)
  const tree = f.component('sidebar.right.pane.tab')(f.props({ status: 'live', value: frame.value }))
  const content = tree.children[1]
  assert.match(content.children[0].children[0], /data-chat-turn="1"/)
  assert.doesNotMatch(content.children[0].children[0], /data-chat-turn="3"/)
  assert.equal(content.children[1].type, 'native-session-provider')
  const next = stream.next()
  abort.abort()
  await next
  assert.ok(f.events.some((event) => event.method === 'hold'))
  assert.ok(f.events.some((event) => event.method === 'release'))
  assert.ok(!f.events.some((event) => /archive|detach/.test(event.method)))
})

test('expired side chats expose a new-chat action and never enable a context-free composer', async () => {
  const f = fixture((method) => method === 'attach' ? { ok: false, error: { code: 'side-chat/expired', message: 'expired fixture' } } : undefined)
  const stream = f.ctx.resource.open(address(), { signal: new AbortController().signal })
  const frame = (await stream.next()).value
  assert.equal(frame.ok, false)
  const tree = f.component('sidebar.right.pane.tab')(f.props({ status: 'failed', failure: frame.error }))
  assert.equal(tree.children[1].props.role, 'alert')
  assert.equal(tree.children[1].children[1].type, 'native-button')
})

test('close failure preserves the tab and shows a retryable dialog; success commits only after backend cleanup', async () => {
  let fail = true
  const f = fixture((method) => method === 'close' && fail ? { ok: false, error: { message: 'cleanup failed' } } : undefined)
  await open(f)
  const tab = { id: 'tab-1', contentId: address() }
  assert.throws(() => f.ctx.beforeClose('parent', tab), /closeTitle/)
  await tick()
  assert.ok(!f.events.some((event) => event.method === 'closed'))
  const tree = f.component('sidebar.right.pane.tab')(f.props({ status: 'loading' }))
  const modalElement = tree.children[2]
  assert.equal(modalElement.props.record.error, 'cleanup failed')
  const dialog = modalElement.type(modalElement.props)
  const buttons = dialog.props.footer.children
  fail = false
  buttons[1].props.onClick()
  await tick()
  assert.equal(f.events.filter((event) => event.method === 'closed').length, 1)
})

test('extends the native More actions menu without replacing its download or feedback behavior', async () => {
  const f = fixture()
  const menuTree = f.component('conversation.session.header.utilities', 'session-log-download')({ sessionId: 'parent' })
  const menu = menuTree.props.children[0]
  assert.deepEqual(Array.from(menu.props.items, (item) => item.id), ['sidechat.new', 'download', 'feedback'])
  assert.equal(menu.type, 'native-menu')
  assert.equal(menuTree.props.children[1].type, 'native-download-dialog')
  menu.props.onSelect('download')
  assert.ok(f.events.some((event) => event.method === 'download'))
  menu.props.onSelect('sidechat.new')
  await tick()
  assert.ok(f.events.some((event) => event.method === 'dismiss-menu'))
  assert.equal(f.events.filter((event) => event.method === 'open').length, 1)
})

test('the new-tab launcher replaces its own occurrence instead of leaving a placeholder', async () => {
  const f = fixture()
  const pending = f.component('sidebar.right.pane.tab', '@local/side-chat/new')({
    useSession: (select) => select({ sessionId: 'parent' }),
    useTabInfo: () => ({ tab: { id: 'launcher-1', signal: new AbortController().signal, actions: { openResource: (contentId, options) => f.events.push({ method: 'replace-launcher', contentId, options }) } } }),
  })
  assert.equal(pending.props.role, 'status')
  await tick()
  const replacement = f.events.find((event) => event.method === 'replace-launcher')
  assert.equal(replacement.options.replaceTab, true)
  assert.equal(f.ctx.shortcut.defaults['desktop:macos'].code, 'KeyS')
  assert.deepEqual(Array.from(f.ctx.shortcut.defaults['desktop:macos'].modifiers), ['primary', 'alt'])
})

test('cancelling a pending tab discards the matching host fork instead of opening it later', async () => {
  let finish
  const f = fixture((method) => method === 'open' ? new Promise((resolve) => { finish = resolve }) : undefined)
  const controller = new AbortController()
  f.component('sidebar.right.pane.tab', '@local/side-chat/new')({
    useSession: (select) => select({ sessionId: 'parent' }),
    useTabInfo: () => ({ tab: { id: 'pending', signal: controller.signal, actions: { openResource: () => f.events.push({ method: 'unexpected-tab' }) } } }),
  })
  controller.abort()
  finish({ ok: true, value: { childId: 'cancelled-child', index: 1, inheritedTurns: [] } })
  await tick()
  assert.equal(f.events.filter((event) => event.method === 'cancel-open').length, 1)
  assert.ok(!f.events.some((event) => event.method === 'unexpected-tab'))
})

test('empty or skip-confirmation closes do not flash a confirmation modal or submit twice', async () => {
  let finish
  const f = fixture((method) => method === 'close' ? new Promise((resolve) => { finish = resolve }) : undefined)
  await open(f)
  const tab = { id: 'tab-1', contentId: address() }
  assert.throws(() => f.ctx.beforeClose('parent', tab), /closeTitle/)
  const tree = f.component('sidebar.right.pane.tab')(f.props({ status: 'loading' }))
  assert.equal(tree.children[2], null)
  assert.throws(() => f.ctx.beforeClose('parent', tab), /closing/)
  assert.equal(f.events.filter((event) => event.method === 'close').length, 1)
  finish({ ok: true, value: { closed: true } })
  await tick()
  assert.equal(f.events.filter((event) => event.method === 'closed').length, 1)
})

test('shortcut defaults pass the real DSH cross-platform registration checks', {
  skip: process.env.DSH_RUNTIME_ROOT === undefined ? 'Set DSH_RUNTIME_ROOT for the shipped shortcut protocol' : false,
}, async () => {
  const protocol = await import(pathToFileURL(resolve(process.env.DSH_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/protocol.js')))
  const f = fixture()
  for (const runtime of ['desktop', 'web']) {
    for (const platform of ['macos', 'windows', 'linux']) {
      const candidate = protocol.resolveShortcutDefault(f.ctx.shortcut, runtime, platform)
      if (candidate === undefined) {
        continue
      }
      const binding = protocol.normalizeBinding(candidate, platform)
      assert.equal(protocol.bindingIssue(binding, runtime, platform), null, `${runtime}:${platform}`)
      if (runtime === 'web') {
        assert.equal(protocol.isWebBindingAllowed(binding, platform), true, `${runtime}:${platform}`)
      }
    }
  }
})
