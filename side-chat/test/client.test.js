import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

function clientFixture(rpc) {
  let bundle
  const events = []
  const components = new Map()
  const sessions = { parent: {}, child: {} }
  const reference = { release: () => events.push('release') }
  const ctx = {
    effect: (factory) => factory(),
    inject: (_services, callback) => callback(ctx),
    get: (name) => ctx[name],
    locale: { register() {}, bind: () => (key, values) => `${key}: ${values?.message ?? ''}` },
    commandUi: { register: (value) => { ctx.command = value } },
    resources: { register: (value) => { ctx.resource = value } },
    sidebarRightTabs: { register() {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => components.set(definition.name, component),
    },
    connection: { rpc: { call: async (_channel, method, payload) => {
      events.push(method)
      return rpc(method, payload)
    } } },
    sessions: {
      list: { getSnapshot: () => ({ byId: sessions }) },
      retain: () => { events.push('retain'); return reference },
      scope: () => ({ get: () => ({ input: { for: () => ({ notify: (_kind, text) => events.push(text) }) } }) }),
    },
    remote: { session: { rename: async () => {} } },
    sidebarRight: { openResource: (address) => { events.push('openResource'); ctx.address = address } },
    uiWorkspace: {
      unarchiveSession: async () => { events.push('unarchive') },
      archiveSession: async (_id, options) => { events.push(`archive:${options.stopActivity}`) },
    },
  }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { bundle = value } } },
    URL, console,
  })
  bundle.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) })).apply(ctx)
  return { ctx, events, components, reference }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const address = 'dsh-resource://sidechat/session/child?parent=parent'

test('deduplicates opens while the host is still creating the fork', async () => {
  let resolveOpen
  const { ctx, events } = clientFixture(() => new Promise((resolve) => { resolveOpen = resolve }))
  ctx.command.ui.run({ sessionId: 'parent' })
  ctx.command.ui.run({ sessionId: 'parent' })
  assert.equal(events.filter((event) => event === 'open').length, 1)
  resolveOpen({ ok: true, value: { childId: 'child' } })
  await tick()
  assert.equal(events.filter((event) => event === 'openResource').length, 1)
})

test('retains native conversation rendering and scopes inherited-turn filtering to this side chat', async () => {
  const { ctx, events, components, reference } = clientFixture(async () => ({ ok: true, value: { inheritedTurns: [1, 2] } }))
  const abort = new AbortController()
  const stream = ctx.resource.open(address, { signal: abort.signal })
  const frame = (await stream.next()).value
  assert.equal(frame.ok, true)
  assert.equal(frame.value.reference, reference)
  const SessionProvider = () => {}
  const tree = components.get('sidebar.right.pane.tab')({
    useTabInfo: () => ({ tab: { contentId: address } }),
    useResource: () => ({ status: 'live', value: frame.value }),
    SessionProvider,
    renderSlot: () => 'native conversation',
  })
  assert.equal(tree.children[1].type, SessionProvider)
  assert.match(tree.children[0].children[0], /\[data-side-chat="child"\] \[data-chat-turn="1"\]/)
  assert.doesNotMatch(tree.children[0].children[0], /data-chat-turn="3"/)
  const next = stream.next()
  abort.abort()
  await next
  await tick()
  assert.deepEqual(events, ['unarchive', 'attach', 'retain', 'release', 'detach', 'archive:true'])
})

test('an attachment failure displays the error without enabling a context-free composer', async () => {
  const { ctx, events, components } = clientFixture(async () => ({ ok: false, error: { message: 'fixture attach failure' } }))
  const stream = ctx.resource.open(address, { signal: new AbortController().signal })
  const frame = (await stream.next()).value
  assert.equal(frame.ok, false)
  assert.ok(!events.includes('retain'))
  const tree = components.get('sidebar.right.pane.tab')({
    useTabInfo: () => ({ tab: { contentId: address } }),
    useResource: () => ({ status: 'failed', failure: frame.error }),
  })
  assert.equal(tree.props.role, 'alert')
  assert.match(tree.children[0], /fixture attach failure/)
  await stream.return()
})
