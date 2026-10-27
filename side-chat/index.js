/**
 * Host half of the side-chat bundle (DSH 0.2.1-rc.3), native-composer mode.
 *
 * The side conversation is an ordinary Session (no `origin=subagent`), so the
 * Client keeps DSH's resident composer, model selection, slash commands, and
 * attachment handling. The Session is created off-workspace, so it shows only
 * under the left sidebar's "Ungrouped" bucket while the tab is open; closing
 * the tab archives it and that row disappears again.
 *
 * The Host forks the completed parent history, then admits new parent records
 * as hidden, sourced background immediately before a human side-chat prompt.
 *
 * Every request-path service is read through `ctx.get(...)`: an HTTP route
 * handler runs outside the plugin fiber, where `ctx.<service>` property access
 * throws, and a throw inside a Web route handler is fatal to the Host process.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSyncMessage, readSyncCursor } from './context.js'

export const name = 'side-chat'

/** The side Agent table and the Web carrier of the private channel. */
export const inject = ['agents', 'sessions', 'sessionQuery', 'systemPrompt', 'workingDirectory', 'agentDefaultModel']

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

  ctx.effect(
    () => async () => {
      await Promise.all([...attached.values()].map(({ fork }) => fork.dispose()))
      attached.clear()
    },
    'side-chat: forget attached side sessions',
  )

  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: (req, res) => {
          void serveChannel(ctx, attached, opening, req, res)
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
async function serveChannel(ctx, attached, opening, req, res) {
  try {
    await serveChannelRequest(ctx, attached, opening, req, res)
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
async function serveChannelRequest(ctx, attached, opening, req, res) {
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
  const result = await dispatch(ctx, attached, opening, endpoint, body.payload)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

/**
 * Route one channel call.
 * @param {*} ctx Host context.
 * @param {Map} attached live side-chat bindings.
 * @param {Map} opening in-flight forks keyed by parent.
 * @param {string} endpoint endpoint name.
 * @param {unknown} payload decoded payload.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: object }}
 */
async function dispatch(ctx, attached, opening, endpoint, payload) {
  try {
    if (endpoint === 'open') {
      const parentSessionId = readString(payload, 'parentSessionId')
      if (parentSessionId === undefined) {
        throw new SideChatError('side-chat/bad-request', 'parentSessionId must be a non-empty string')
      }
      if (!opening.has(parentSessionId)) {
        opening.set(parentSessionId, openSideChat(ctx, attached, parentSessionId).finally(() => {
          opening.delete(parentSessionId)
        }))
      }
      return { ok: true, value: await opening.get(parentSessionId) }
    }
    if (endpoint === 'attach') {
      return { ok: true, value: await attachContext(ctx, attached, payload) }
    }
    if (endpoint === 'detach') {
      return { ok: true, value: await detachContext(attached, payload) }
    }
    throw new SideChatError('side-chat/bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
  } catch (error) {
    if (error instanceof SideChatError) {
      return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
    }
    return { ok: false, error: { code: 'side-chat/internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
}

/** Fork a balanced prefix without attaching the ordinary Session to a workspace. */
async function openSideChat(ctx, attached, parentSessionId) {
  const agents = service(ctx, 'agents')
  const parent = agents.get(parentSessionId)
  if (parent === undefined) {
    throw new SideChatError('side-chat/parent-unavailable', 'the main conversation is not live', { parentSessionId })
  }
  for (const [childId, binding] of attached) {
    if (binding.parentSessionId === parentSessionId && agents.get(childId) === binding.child) {
      return { childId }
    }
  }
  const observation = await service(ctx, 'sessionQuery').observeSession(parentSessionId, { projections: 'none' })
  let seed
  try {
    const events = observation.events
    const boundary = events.findLastIndex((event) => event.type === 'turn/end')
    seed = events.slice(0, boundary + 1)
  } finally {
    observation[Symbol.dispose]()
  }
  const childId = `session-${randomUUID()}`
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  const cwd = parent.ctx.get('workingDirectory').get(parent.session)
  const { agent: child } = await agents.create({
    sessionId: childId,
    seed,
    inheritedEventCount: seed.length,
    meta: {
      cwd,
      parentSession: parentSessionId,
      isSeeded: true,
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    agentOptions: modelOptions(parent.session.requestHeader()?.config ?? parent.options),
    setup: (scope, agent) => {
      scope.get('agentPresets')?.composeFrom(scope, parent.ctx)
      // Forked pending prompts must never wake the child or repeat parent work.
      agent.inbox.clear()
      agent.session.append('working-directory/change', { cwd })
      const sandbox = parent.ctx.get('sandboxPolicy')
      if (sandbox !== undefined) {
        const policy = sandbox.resolve({ session: parent.session })
        agent.session.append('sandbox/mode', { mode: policy.mode, source: 'delegation' })
      }
      const approval = parent.ctx.get('approval')
      if (approval !== undefined) {
        agent.session.append('approval/policy', { policy: approval.effectivePolicy(parent.session) })
      }
    },
  })
  await bindContext(ctx, attached, child, parentSessionId)
  return { childId }
}

function modelOptions(config) {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
  }
}

/** An unpublished replay uses DSH's own compaction and image-offload projections. */
function replaySnapshot(ctx, events) {
  return service(ctx, 'sessions').prepare(`side-chat-read-${randomUUID()}`, { seed: events })
}

/** Restore a fork and its durable synchronization cursor after a page/app restart. */
async function attachContext(ctx, attached, payload) {
  const parentSessionId = readString(payload, 'parentSessionId')
  const childId = readString(payload, 'childId')
  if (parentSessionId === undefined || childId === undefined) {
    throw new SideChatError('side-chat/bad-request', 'parentSessionId and childId must be non-empty strings')
  }
  const agents = service(ctx, 'agents')
  const observation = await service(ctx, 'sessionQuery').observeSession(childId, { projections: 'none' })
  try {
    if (!observation.header.isSeeded || observation.header.parentSession !== parentSessionId) {
      throw new SideChatError('side-chat/not-a-fork', '此会话不是该主对话的侧聊分叉，请关闭旧标签后重新打开。')
    }
    let child = agents.get(childId)
    if (child === undefined) {
      const config = replaySnapshot(ctx, observation.events).requestHeader()?.config
        ?? service(ctx, 'agentDefaultModel').currentSelection()
      const handle = await agents.resume({
        resumeSessionId: childId,
        agentOptions: modelOptions(config),
        setup: async (scope) => {
          if (observation.header.agentPreset !== undefined) {
            await scope.get('agentPresets').mount(scope, observation.header.agentPreset)
          }
        },
      })
      child = handle.agent
    }
    return await bindContext(ctx, attached, child, parentSessionId)
  } finally {
    observation[Symbol.dispose]()
  }
}

/** Install stable behavior rules and sync only when human input enters a step. */
async function bindContext(ctx, attached, child, parentSessionId) {
  const existing = attached.get(child.id)
  if (existing?.child === child) {
    return { attached: true, inheritedTurns: existing.inheritedTurns }
  }
  const observation = await service(ctx, 'sessionQuery').observeSession(child.id, { projections: 'none' })
  let binding
  try {
    binding = {
      child,
      parentSessionId,
      inheritedTurns: observation.events.slice(0, child.session.inheritedEventCount)
        .filter((event) => event.type === 'turn/start').map((event) => event.data.turn),
      throughSeq: readSyncCursor(observation.events, child.session.inheritedEventCount, parentSessionId),
    }
  } finally {
    observation[Symbol.dispose]()
  }
  binding.fork = child.ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'side-chat:instructions',
      order: 10300,
      text: SIDE_CHAT_RULES,
      interpolate: false,
    })
    scope.on('session/event', (session, event) => {
      if (session === child.session && event.type === 'user/message'
        && event.data.source.kind === 'side-chat:sync') {
        binding.throughSeq = event.data.source.throughSeq
      }
    })
    scope.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || !decision.messages.some((message) => message.source.kind === 'user')) {
        return decision
      }
      let parent
      try {
        parent = await service(ctx, 'sessionQuery').observeSession(parentSessionId, {
          signal: payload.signal,
          projections: 'none',
        })
        if (parent.cursor <= binding.throughSeq) {
          return decision
        }
        const events = parent.events
        const snapshot = replaySnapshot(ctx, events)
        const update = createSyncMessage(parentSessionId, binding.throughSeq, snapshot, events)
        payload.signal.throwIfAborted()
        if (update === undefined) {
          return decision
        }
        return { ...decision, messages: [update, ...decision.messages] }
      } catch (error) {
        if (!payload.signal.aborted) {
          // Admission claimed these inputs before syncing. Keep the question
          // queued for a retry instead of silently losing it on a read failure.
          const human = decision.messages.filter((message) => message.source.kind === 'user')
          for (const message of human.reverse()) {
            child.inbox.prepend('next-turn', message)
          }
        }
        throw new Error(`主对话增量同步失败，本轮未请求模型：${error.message}`, { cause: error })
      } finally {
        parent?.[Symbol.dispose]()
      }
    })
  })
  attached.set(child.id, binding)
  return { attached: true, inheritedTurns: binding.inheritedTurns }
}

/** Dispose the scoped rules/listeners when a tab releases this attachment. */
async function detachContext(attached, payload) {
  const childId = readString(payload, 'childId')
  if (childId === undefined) {
    throw new SideChatError('side-chat/bad-request', 'childId must be a non-empty string')
  }
  const binding = attached.get(childId)
  if (binding !== undefined) {
    attached.delete(childId)
    await binding.fork.dispose()
  }
  return { detached: true }
}

/**
 * Read one non-empty string field.
 * @param {unknown} payload decoded payload.
 * @param {string} key field name.
 * @returns {string | undefined}
 */
function readString(payload, key) {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
