/**
 * Host half of the side-chat bundle (DSH 0.2.1-rc.3), native-composer mode.
 *
 * The side conversation is an ordinary Session (no `origin=subagent`), so the
 * Client keeps DSH's resident composer, model selection, slash commands, and
 * attachment handling. The Session is created off-workspace, so it shows only
 * under the left sidebar's "Ungrouped" bucket while the tab is open; closing
 * the tab archives it and that row disappears again.
 *
 * What this Host half owns: the main conversation's context. It registers a
 * scoped, hidden prompt context on the side Agent's own Agent context, so each
 * request re-reads the latest main-conversation log instead of pasting a
 * snapshot into the transcript.
 *
 * Every request-path service is read through `ctx.get(...)`: an HTTP route
 * handler runs outside the plugin fiber, where `ctx.<service>` property access
 * throws, and a throw inside a Web route handler is fatal to the Host process.
 */

export const name = 'side-chat'

/** The side Agent table and the Web carrier of the private channel. */
export const inject = ['agents']

/** Client ⇄ Host channel for context attachment. */
const CHANNEL = '/side-chat'

const MAX_DIGEST_CHARS = 12000
const MAX_MESSAGE_CHARS = 1200

const CONTEXT_PREAMBLE =
  '你正在一段“侧栏对话”里回答用户。下面是主对话截至当前请求的最近记录摘录，只作为背景参考：' +
  '它不是本对话里用户的发言，不要逐条回应，也不要复述这段说明本身。'

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
  /** Side Agent identity → the main parent whose context it renders. */
  const attached = new Map()

  ctx.effect(
    () => () => {
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
          void serveChannel(ctx, attached, req, res)
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
 * @param {Map<string, string>} attached side Session id → parent Session id.
 * @param {import('node:http').IncomingMessage} req node request.
 * @param {import('node:http').ServerResponse} res node response.
 * @returns {Promise<void>}
 */
async function serveChannel(ctx, attached, req, res) {
  try {
    await serveChannelRequest(ctx, attached, req, res)
  } catch (_error) {
    try {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    } catch (_unavailable) {
      // The socket is already gone.
    }
  }
}

/**
 * Answer one channel request after {@link serveChannel} installed its boundary.
 * @param {*} ctx Host context.
 * @param {Map<string, string>} attached side Session id → parent Session id.
 * @param {import('node:http').IncomingMessage} req node request.
 * @param {import('node:http').ServerResponse} res node response.
 * @returns {Promise<void>}
 */
async function serveChannelRequest(ctx, attached, req, res) {
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
  for await (const chunk of req) chunks.push(chunk)
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
  const result = await dispatch(ctx, attached, endpoint, body.payload)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

/**
 * Route one channel call.
 * @param {*} ctx Host context.
 * @param {Map<string, string>} attached side Session id → parent Session id.
 * @param {string} endpoint endpoint name.
 * @param {unknown} payload decoded payload.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: object }}
 */
function dispatch(ctx, attached, endpoint, payload) {
  try {
    if (endpoint === 'attach') {
      return { ok: true, value: attachContext(ctx, attached, payload) }
    }
    if (endpoint === 'detach') {
      return { ok: true, value: detachContext(attached, payload) }
    }
    throw new SideChatError('side-chat/bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
  } catch (error) {
    if (error instanceof SideChatError) {
      return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
    }
    return { ok: false, error: { code: 'side-chat/internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
}

/**
 * Register the parent conversation's hidden context on one live side Agent.
 * Registering twice for the same live Agent is a no-op.
 * @param {*} ctx Host context.
 * @param {Map<string, string>} attached side Session id → parent Session id.
 * @param {unknown} payload `{ parentSessionId, childId }`.
 * @returns {{ attached: true }}
 */
function attachContext(ctx, attached, payload) {
  const parentSessionId = readString(payload, 'parentSessionId')
  const childId = readString(payload, 'childId')
  if (parentSessionId === undefined || childId === undefined) {
    throw new SideChatError('side-chat/bad-request', 'parentSessionId and childId must be non-empty strings')
  }
  const agents = service(ctx, 'agents')
  const parent = agents?.get(parentSessionId)
  const child = agents?.get(childId)
  if (parent === undefined) {
    throw new SideChatError('side-chat/parent-unavailable', 'the main conversation is not live', { parentSessionId })
  }
  if (child === undefined) {
    throw new SideChatError('side-chat/child-unavailable', 'the side conversation is not live', { childId })
  }
  if (attached.get(childId) === parentSessionId) {
    return { attached: true }
  }
  child.ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(
      () => scope.systemPrompt.context({
        name: 'side-chat:context',
        order: 1000,
        text: () => buildDigest(parent) ?? '',
      }),
      'side-chat: main conversation context',
    )
  })
  attached.set(childId, parentSessionId)
  return { attached: true }
}

/**
 * Forget one side Agent's attachment (the scoped context lives with the Agent).
 * @param {Map<string, string>} attached side Session id → parent Session id.
 * @param {unknown} payload `{ childId }`.
 * @returns {{ detached: true }}
 */
function detachContext(attached, payload) {
  const childId = readString(payload, 'childId')
  if (childId === undefined) {
    throw new SideChatError('side-chat/bad-request', 'childId must be a non-empty string')
  }
  attached.delete(childId)
  return { detached: true }
}

/**
 * One hidden Context message summarizing the main conversation, capped so a
 * long session cannot dominate the side Agent's request.
 * @param {*} parent live main Agent.
 * @returns {string | undefined} model-facing text, or undefined for an empty conversation.
 */
function buildDigest(parent) {
  const messages = parent.session.deriveMessages()
  const lines = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const role = message.role
    if (role !== 'user' && role !== 'assistant') {
      continue
    }
    if (role === 'user' && message.source?.kind !== 'user') {
      continue
    }
    if (role === 'assistant' && message.source?.kind !== 'model') {
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') {
      continue
    }
    const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
    const line = `${role === 'user' ? '用户' : '助手'}：${clipped}`
    if (used + line.length > MAX_DIGEST_CHARS) {
      break
    }
    lines.push(line)
    used += line.length
  }
  if (lines.length === 0) {
    return undefined
  }
  lines.reverse()
  return `${CONTEXT_PREAMBLE}\n\n${lines.join('\n')}`
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
