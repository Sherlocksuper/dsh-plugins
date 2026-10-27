import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSyncMessage, readSyncCursor, SYNC_SOURCE } from '../context.js'

function fixture(messages, positions = messages.map((_, index) => index)) {
  const events = Array.from({ length: Math.max(-1, ...positions) + 1 }, () => ({}))
  for (let index = 0; index < messages.length; index++) {
    events[positions[index]] = { message: messages[index] }
  }
  return {
    events,
    snapshot: {
      surface: { nodes: positions },
      deriveEventMessage: (event) => event.message,
    },
  }
}

function message(role, content, metadata = {}) {
  return { id: crypto.randomUUID(), role, source: { kind: role }, content, ...metadata }
}

function sync(input, afterSeq = -1) {
  return createSyncMessage('parent', afterSeq, input.snapshot, input.events)
}

function textOf(update) {
  return update.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

test('copies complete long text and emits only the unsynchronized parent suffix', () => {
  const longText = '完整上下文'.repeat(4000)
  const input = fixture([
    message('user', [{ type: 'text', text: 'inherited question' }]),
    message('assistant', [{ type: 'text', text: longText }]),
  ])
  const update = sync(input, 0)
  assert.ok(textOf(update).includes(longText))
  assert.ok(!textOf(update).includes('inherited question'))
  assert.equal(update.source.throughSeq, 1)
  assert.equal(sync(input, update.source.throughSeq), undefined)
})

test('retains source roles, tool arguments, results, and errors as background data', () => {
  const input = fixture([
    message('assistant', [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"src/main.js"}' }]),
    message('tool', [{ type: 'text', text: 'permission denied' }], { toolCallId: 'call-1', isError: true }),
  ])
  const update = sync(input)
  const text = textOf(update)
  assert.match(text, /"role":"assistant"/)
  assert.match(text, /"role":"tool"/)
  assert.match(text, /permission denied/)
  assert.match(text, /"isError":true/)
  assert.match(text, /src\/main.js/)
  assert.ok(update.content.every((block) => block.type !== 'tool-call'))
})

test('defers a partially completed parallel tool group without losing the earlier user question', () => {
  const user = message('user', [{ type: 'text', text: 'new parent question' }])
  const calls = message('assistant', [
    { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' },
    { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' },
  ])
  const firstResult = message('tool', [{ type: 'text', text: 'first result' }], { toolCallId: 'a' })
  const first = sync(fixture([user, calls, firstResult]))
  assert.match(textOf(first), /new parent question/)
  assert.doesNotMatch(textOf(first), /first result/)
  assert.equal(first.source.throughSeq, 0)
  const secondResult = message('tool', [{ type: 'text', text: 'second result' }], { toolCallId: 'b' })
  const next = sync(fixture([user, calls, firstResult, secondResult]), first.source.throughSeq)
  assert.match(textOf(next), /first result/)
  assert.match(textOf(next), /second result/)
  assert.doesNotMatch(textOf(next), /new parent question/)
})

test('keeps native image/file blocks detached from the parent and quotes other blocks', () => {
  const image = { type: 'image', attachment: { provider: 'local', id: 'image-1' } }
  const file = { type: 'file', attachment: { provider: 'local', id: 'file-1' } }
  const update = sync(fixture([message('user', [image, file])]))
  assert.deepEqual(update.content.filter((block) => block.type !== 'text'), [image, file])
  assert.notEqual(update.content[2], image)
})

test('does not copy parent system/runtime prompts or private provider replay state into updates', () => {
  const input = fixture([
    message('system', [{ type: 'text', text: 'parent system prompt' }]),
    message('user', [{ type: 'text', text: 'parent runtime facts' }], { source: { kind: 'runtime-context' } }),
    message('assistant', [{ type: 'text', text: 'a conclusion' }], { source: { kind: 'model', replayState: 'opaque-provider-state' } }),
  ])
  const text = textOf(sync(input))
  assert.doesNotMatch(text, /parent system prompt|parent runtime facts|opaque-provider-state/)
  assert.match(text, /a conclusion/)
})

test('uses surface order after compaction and does not advance past an unresolved tool call', () => {
  const input = fixture([
    message('system', [{ type: 'text', text: 'rewritten system' }]),
    message('user', [{ type: 'text', text: 'new question' }]),
    message('assistant', [{ type: 'tool-call', id: 'pending', name: 'read', arguments: '{}' }]),
  ], [20, 5, 8])
  const update = sync(input, 4)
  assert.match(textOf(update), /new question/)
  assert.equal(update.source.throughSeq, 7)
})

test('recovers the latest committed own cursor while ignoring inherited and foreign markers', () => {
  function marker(parentSessionId, throughSeq) {
    return { type: 'user/message', data: { source: { kind: SYNC_SOURCE, parentSessionId, throughSeq } } }
  }
  const events = [marker('parent', 100), marker('parent', 12), marker('other-parent', 999), marker('parent', 25)]
  assert.equal(readSyncCursor(events, 1, 'parent'), 25)
  assert.equal(readSyncCursor(events.slice(0, 1), 1, 'parent'), 0)
  assert.equal(readSyncCursor([], 0, 'parent'), -1)
})
