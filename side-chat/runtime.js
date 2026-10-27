/** DSH 0.2.1-rc.3 adapters for memory-only forks with the native composer. */

export function prepareSideFork(sessions, parent, childId) {
  // Reuse DSH's exact fork boundary and interrupted-tool recovery. Replace only
  // publication: the Agent factory must own that lifetime, without a disk writer.
  const store = new Proxy(sessions, {
    get(target, key, receiver) {
      if (key === 'create') {
        return (id, options) => target.prepare(id, options)
      }
      return Reflect.get(target, key, receiver)
    },
  })
  return store.fork(parent, undefined, childId)
}

export async function publishSideAgent(ctx, session, options, setup) {
  const loop = ctx.get('agentLoop')
  // setupAndPublish is the same transaction agents.create uses, but an absent
  // stored handle leaves this Session entirely in memory. Never create/flush a
  // JSONL handle and then try to erase it after the fact.
  const preparation = { session, [Symbol.dispose]() {} }
  return loop.setupAndPublish(ctx, session.id, preparation, options, setup, undefined, 'startup', undefined)
}

export function hideSideHistory(ctx, bindings) {
  const list = ctx.get('sessionController').listState
  const original = list.summaryFor
  const query = ctx.get('sessionQuery')
  const corpus = query._corpus
  const listSessions = corpus.listSessions
  const searchSessions = query.searchSessions
  corpus.listSessions = async function (...args) {
    return (await listSessions.apply(this, args)).filter((record) => !bindings.has(record.header.id))
  }
  // SQLite search has its own live-session index. Its continuation cursor still
  // belongs to the original page; callers can follow it past a filtered page.
  if (searchSessions !== undefined) {
    query.searchSessions = async function (...args) {
      const page = await searchSessions.apply(this, args)
      return { ...page, items: page.items.filter((hit) => !bindings.has(hit.header.id)) }
    }
  }
  list.summaryFor = function (session) {
    const summary = original.call(this, session)
    if (!bindings.has(session.id)) {
      return summary
    }
    // DSH's list has one existing hidden-origin marker. Apply it only to the
    // navigation summary, never the real header: the latter must keep ordinary
    // prompt/model/attachment routing. Omitting parentSessionId prevents Client
    // SessionManager from inventing a subagent continuation address.
    const { parentSessionId: _parentSessionId, ...fields } = summary
    return { ...fields, origin: 'subagent' }
  }
  return () => {
    list.summaryFor = original
    corpus.listSessions = listSessions
    if (searchSessions !== undefined) {
      query.searchSessions = searchSessions
    }
  }
}
