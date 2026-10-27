/** Temporary side conversations for DSH 0.2.1-rc.3. Native forks, composer,
 * and tools; no persistence handle, workspace membership, or parent syncing. */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hideSideHistory, prepareSideFork, publishSideAgent } from './runtime.js'

export const name = 'side-chat'

/** The side Agent table and the Web carrier of the private channel. */
export const inject = ['agents', 'agentLoop', 'sessions', 'sessionController', 'sessionQuery', 'systemPrompt', 'workingDirectory', 'tools']

/** Client ⇄ Host channel for context attachment. */
const CHANNEL = '/side-chat'

const SIDE_CHAT_RULES = readFileSync(new URL('./prompts/AGENTS.md', import.meta.url), 'utf8')

/**
 * Read one Host service without property access; request handlers run outside
 * the plugin fiber, where `ctx.<service>` would throw "without inject".
 * @param {*} ctx Host context.
 * @param {string} name service name.
 * @returns {*} the service, or undefined.
 */
function service(ctx, name) {
  return ctx.get(name)
}

/**
 * Install the context-attachment channel.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const attached = new Map()
  const opening = new Map()
  const clients = new Map()

  ctx.effect(() => hideSideHistory(ctx, attached), 'side-chat: transient history boundary')
  ctx.effect(() => async () => {
    await Promise.all([...attached.values()].filter((binding) => binding.handle !== undefined).map((binding) => closeSideChat(attached, opening, binding)))
    for (const finish of clients.values()) {
      finish()
    }
  }, 'side-chat: dispose transient agents')

  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: (req, res) => {
          void serveChannel(ctx, attached, opening, clients, req, res)
        },
      }),
      'side-chat: context channel',
    )
  })
}

/** Expected, Client-addressable failure. */
class SideChatError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SideChatError'
    this.code = code
    this.details = details
  }
}

/**
 * Serve one Connection-shaped RPC request on the plugin's authenticated route.
 * @param {*} ctx Host context.
 * @param {Map} attached live side-chat bindings.
 * @param {Map} opening in-flight forks keyed by parent.
 * @param {import('node:http').IncomingMessage} req node request.
 * @param {import('node:http').ServerResponse} res node response.
 * @returns {Promise<void>}
 */
async function serveChannel(ctx, attached, opening, clients, req, res) {
  try {
    await serveChannelRequest(ctx, attached, opening, clients, req, res)
  } catch (_error) {
    try {
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end()
    } catch (_unavailable) {
      // The socket is already gone.
    }
  }
}

/**
 * Answer one channel request after {@link serveChannel} installed its boundary.
 * @param {*} ctx Host context.
 * @param {Map} attached live side-chat bindings.
 * @param {Map} opening in-flight forks keyed by parent.
 * @param {import('node:http').IncomingMessage} req node request.
 * @param {import('node:http').ServerResponse} res node response.
 * @returns {Promise<void>}
 */
async function serveChannelRequest(ctx, attached, opening, clients, req, res) {
  const connection = service(ctx, 'connection')
  if (connection === undefined) {
    res.writeHead(503)
    res.end()
    return
  }
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const endpoint = pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : undefined
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    res.writeHead(415)
    res.end()
    return
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (typeof body !== 'object' || body === null || body.type !== 'client-request'
    || typeof body.rpcId !== 'string' || body.method !== endpoint) {
    res.writeHead(400)
    res.end()
    return
  }
  if (endpoint === 'hold') {
    const clientId = readString(body.payload, 'clientId')
    if (clientId === undefined || clients.has(clientId)) {
      res.writeHead(400)
      res.end()
      return
    }
    // One held connection per window, shared by all its side chats. One per
    // tab would exhaust the browser's HTTP/1 connection pool with several tabs.
    await new Promise((resolve) => {
      const finish = () => { clients.delete(clientId); resolve() }
      clients.set(clientId, finish)
      res.once('close', () => {
        finish()
        for (const binding of attached.values()) {
          binding.holders.delete(clientId)
          if (binding.holders.size === 0) {
            closeSideChat(attached, opening, binding).catch((error) => {
              console.warn('[side-chat] cleanup failed', error)
            })
          }
        }
      })
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { closed: true } } }))
    return
  }
  const result = await dispatch(ctx, attached, opening, endpoint, body.payload)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

/** Plugin-owned transient side chats. Repeated transport requests are idempotent. */
async function dispatch(ctx, attached, opening, endpoint, payload) {
  try {
    if (endpoint === 'cancel-open') {
      const requestId = readString(payload, 'requestId')
      if (requestId === undefined) {
        throw new SideChatError('side-chat/bad-request', 'requestId is required')
      }
      const pending = opening.get(requestId)
      if (pending !== undefined) {
        const { childId } = await pending
        const binding = attached.get(childId)
        if (binding !== undefined) {
          await closeSideChat(attached, opening, binding)
        }
      }
      return { ok: true, value: { cancelled: true } }
    }
    if (endpoint === 'open') {
      const parentSessionId = readString(payload, 'parentSessionId')
      const requestId = readString(payload, 'requestId')
      if (parentSessionId === undefined || requestId === undefined) {
        throw new SideChatError('side-chat/bad-request', 'parentSessionId and requestId are required')
      }
      if (!opening.has(requestId)) {
        const task = openSideChat(ctx, attached, parentSessionId, requestId)
        opening.set(requestId, task)
        task.catch(() => opening.delete(requestId))
      }
      return { ok: true, value: await opening.get(requestId) }
    }
    const childId = readString(payload, 'childId')
    if (childId === undefined) {
      throw new SideChatError('side-chat/bad-request', 'childId is required')
    }
    const binding = attached.get(childId)
    if (binding === undefined || binding.handle === undefined) {
      throw new SideChatError('side-chat/expired', '这段临时侧聊已结束，请新建侧聊。')
    }
    if (endpoint === 'attach') {
      if (binding.parentSessionId !== readString(payload, 'parentSessionId')) {
        throw new SideChatError('side-chat/wrong-parent', '侧聊不属于当前主对话。')
      }
      const clientId = readString(payload, 'clientId')
      if (clientId === undefined) {
        throw new SideChatError('side-chat/bad-request', 'clientId is required')
      }
      binding.holders.add(clientId)
      return { ok: true, value: describe(binding) }
    }
    if (endpoint === 'release') {
      binding.holders.delete(readString(payload, 'clientId'))
      if (binding.holders.size === 0) {
        await closeSideChat(attached, opening, binding)
      }
      return { ok: true, value: { released: true } }
    }
    if (endpoint === 'close') {
      await closeSideChat(attached, opening, binding)
      return { ok: true, value: { closed: true } }
    }
    throw new SideChatError('side-chat/bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
  } catch (error) {
    return { ok: false, error: {
      code: error instanceof SideChatError ? error.code : 'side-chat/internal',
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof SideChatError ? error.details : {},
    } }
  }
}

function describe(binding) {
  return {
    childId: binding.childId,
    index: binding.index,
    inheritedTurns: binding.inheritedTurns,
  }
}

async function openSideChat(ctx, attached, parentSessionId, requestId) {
  const parent = service(ctx, 'agents').get(parentSessionId)
  if (parent === undefined) {
    throw new SideChatError('side-chat/parent-unavailable', '主对话尚未就绪，请稍后重试。')
  }
  if (attached.has(parentSessionId)) {
    throw new SideChatError('side-chat/nested', '侧聊中不能再创建侧聊。')
  }
  const childId = `side-chat-${randomUUID()}`
  const index = [...attached.values()].filter((value) => value.parentSessionId === parentSessionId).length + 1
  const binding = { childId, parentSessionId, requestId, index, holders: new Set() }
  attached.set(childId, binding)
  try {
    const session = prepareSideFork(service(ctx, 'sessions'), parent.session, childId)
    binding.inheritedTurns = session.snapshotEvents().filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
    const cwd = parent.ctx.get('workingDirectory').get(parent.session)
    binding.ready = publishSideAgent(ctx, session, modelOptions(parent.session.requestHeader()?.config ?? parent.options), (scope, agent) => {
      scope.get('agentPresets')?.composeFrom(scope, parent.ctx)
      agent.inbox.clear()
      agent.session.append('working-directory/change', { cwd })
      const sandbox = parent.ctx.get('sandboxPolicy')
      if (sandbox !== undefined) {
        agent.session.append('sandbox/mode', { mode: sandbox.resolve({ session: parent.session }).mode, source: 'delegation' })
      }
      const approval = parent.ctx.get('approval')
      if (approval !== undefined) {
        agent.session.append('approval/policy', { policy: approval.effectivePolicy(parent.session) })
      }
      scope.get('systemPrompt').section({ name: 'side-chat:instructions', order: 10300, text: SIDE_CHAT_RULES, interpolate: false })
      // A model must never turn inherited pending work into an active task.
      agent.inject({
        id: randomUUID(), role: 'user', source: { kind: 'side-chat:boundary' },
        content: [{ type: 'text', text: SIDE_CHAT_RULES }],
      })
      scope.get('tools').guard((execution) => {
        if (/(?:^|[_.-])(?:subagent|spawn_agent|list_agents|wait_agent|send_message|interrupt_agent|followup_task|send_message_to_agent)(?:$|[_.-])/i.test(execution.name)) {
          return 'Sub-agents are off-limits in this side conversation.'
        }
        if (execution.name === 'create_worktree') {
          return 'Open the main chat to create a worktree.'
        }
        return undefined
      })
    })
    binding.handle = await binding.ready
    return describe(binding)
  } catch (error) {
    attached.delete(childId)
    throw error
  }
}

async function closeSideChat(attached, opening, binding) {
  if (binding.closing !== undefined) {
    return binding.closing
  }
  binding.closing = (async () => {
    try {
      const handle = await binding.ready
      await handle.dispose()
      attached.delete(binding.childId)
      opening.delete(binding.requestId)

    } finally {
      binding.closing = undefined
    }
  })()
  return binding.closing
}

function modelOptions(config) {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
  }
}

function readString(payload, key) {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
