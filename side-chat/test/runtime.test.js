import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sideChat from '../index.js';

const runtimeRoot = process.env.DSH_RUNTIME_ROOT;

test('memory-only native forks, independent snapshots, close, and transport idempotency', {
  skip: runtimeRoot === undefined ? 'Set DSH_RUNTIME_ROOT to an unpacked DSH runtime to run integration checks' : false,
  timeout: 10000,
}, async () => {
  async function load(name) {
    return import(pathToFileURL(resolve(runtimeRoot, 'node_modules', '@deepseek-ai', name, 'lib/index.js')));
  }
  const [
    { Context }, { default: Sessions }, { default: Agents }, { default: AgentLoop },
    { default: SystemPrompt }, { default: Projections }, { default: Query },
    { default: Tools, defineTool }, { default: Llm, LlmAdapter, createUserMessage }, Persistence, { default: SandboxPolicy }, Checkpoints,
  ] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt',
    'dsh-session-projection', 'dsh-session-query-sqlite', 'dsh-tools', 'dsh-llm', 'dsh-session-persistence-jsonl', 'dsh-sandbox-policy', 'dsh-session-checkpoint-policy',
  ].map(load));
  const root = new Context();
  root.on('internal/error', (error) => { console.error(error); });
  const errors = [];
  root.on('agent/error', ({ error }) => { errors.push(error); }, { global: true });
  const requests = [];
  const handles = new Map();
  class FixtureAgents extends Agents {
    async create(options) {
      const handle = await super.create(options);
      handles.set(handle.agent.id, handle);
      return handle;
    }
  }
  class FixtureModel extends LlmAdapter {
    async *stream(request) {
      requests.push(request);
      yield { type: 'text-delta', index: 0, text: 'fixture reply' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    }
  }
  let route;
  root.plugin(Sessions);
  root.plugin(FixtureAgents);
  root.plugin(Projections);
  root.plugin(SystemPrompt, {});
  root.plugin(SandboxPolicy, { mode: 'read-only' });
  root.plugin(Tools, {});
  root.plugin(Llm);
  root.plugin(Checkpoints);
  root.plugin(Query, { path: ':memory:', openAt: 'first-search' });
  const persistenceRoot = await mkdtemp(resolve(tmpdir(), 'side-chat-runtime-'));
  await root.plugin(Persistence, { root: persistenceRoot, compression: 'none', listConcurrency: 1 }).await();
  root.inject(['sessionPersistence'], (scope) => {
    scope.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 });
  });
  root.plugin({ name: 'fixture-services', inject: ['llm'], apply(ctx) {
    ctx.provide('sessionController', { listState: { summaryFor: (session) => ({ sessionId: session.id, parentSessionId: session.header.parentSession, origin: session.header.origin }) } });
    ctx.provide('connection', { requestRejection: () => undefined });
    ctx.provide('webServer', { register(value) { route = value; return () => {}; } });
    ctx.provide('workingDirectory', { get: (session) => session.header.cwd });
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) });
    ctx.provide('agentPresets', {
      composedPreset: () => 'fixture-preset',
      composeFrom() {},
      mount: async () => ({ id: 'fixture-preset' }),
    });
    ctx.get('llm').registerAdapter(['fixture'], new FixtureModel());
  } });
  root.plugin(sideChat);
  let subagentCalls = 0;
  root.plugin({ name: 'fixture-subagent-tool', inject: ['tools'], apply(ctx) {
    ctx.get('tools').register(defineTool({
      name: 'subagent', description: 'Fixture delegation', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { subagentCalls++; return 'delegated'; },
    }));
  } });

  async function rpc(method, payload) {
    const body = JSON.stringify({ type: 'client-request', rpcId: method, method, payload });
    const request = Readable.from([Buffer.from(body)]);
    request.url = `/side-chat/${method}`;
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    return await new Promise((resolve, reject) => {
      route.handler(request, {
        writeHead(status) { this.status = status; },
        end(value) {
          if (this.status !== 200) {
            reject(new Error(`HTTP ${this.status}`));
            return;
          }
          resolve(JSON.parse(value).result);
        },
      });
    });
  }

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const handle = await root.get('agents').create({
      sessionId: 'fixture-parent',
      meta: { cwd: persistenceRoot },
      agentOptions: { provider: 'fixture', model: 'fixture' },
    });
    const parent = handle.agent;
    parent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'user' });
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'initial parent question' }] }));
    await parent.whenIdle();
    assert.equal(requests.length, 1);
    assert.equal(parent.session.deriveMessages().at(-1).role, 'assistant');
    parent.session.append('sandbox/mode', { mode: 'read-only', source: 'user' });
    const opened = await rpc('open', { parentSessionId: parent.id, requestId: 'first-open' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const childId = opened.value.childId;
    const child = root.get('agents').get(childId);
    assert.equal(child.session.header.parentSession, parent.id);
    assert.equal(child.session.header.origin, undefined, 'native prompts must keep ordinary routing');
    assert.equal(root.get('sandboxPolicy').resolve({ session: child.session }).mode, 'read-only');
    assert.deepEqual(child.session.deriveMessages(), parent.session.deriveMessages());
    const summary = root.get('sessionController').listState.summaryFor(child.session);
    assert.equal(summary.origin, 'subagent', 'the navigation summary uses the existing hidden marker');
    assert.equal(summary.parentSessionId, undefined, 'do not synthesize a subagent prompt address');
    assert.equal(Object.hasOwn(summary, 'parentSessionId'), false, 'wire data must omit absent fields rather than serialize undefined');
    assert.equal(root.get('sessionController').listState.summaryFor(parent.session).origin, undefined);
    assert.ok(!(await root.get('sessionQuery').listSessions()).some((record) => record.header.id === childId), 'temporary sessions must not enter history queries');
    assert.equal((await root.get('sessionQuery').filterSessions([{ kind: 'id', values: [childId] }])).length, 0);
    const diskBefore = await readdir(persistenceRoot, { recursive: true });
    assert.ok(!diskBefore.some((name) => name.includes(childId)), 'no side-chat storage handle or log');

    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fresh parent detail' }] }));
    await parent.whenIdle();
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'side question' }] }));
    await child.whenIdle();
    const sideRequest = requests.at(-1);
    assert.equal(sideRequest.sessionId, childId);
    assert.doesNotMatch(JSON.stringify(sideRequest.messages), /fresh parent detail/);
    assert.match(JSON.stringify(sideRequest.messages), /initial parent question/);
    assert.match(JSON.stringify(sideRequest.messages), /侧聊行为规则/);
    assert.equal(sideRequest.messages.filter((message) => message.source.kind === 'side-chat:boundary').length, 1);
    assert.equal(errors.length, 0, errors.map((error) => error.stack).join('\n'));
    const search = await root.get('sessionQuery').searchSessions({ query: 'initial parent', limit: 20 });
    assert.ok(search.items.some((hit) => hit.header.id === parent.id));
    assert.ok(!search.items.some((hit) => hit.header.id === childId), 'full-text search cannot disclose transient side chats');

    const tools = root.get('tools');
    const denied = await tools.execute({ name: 'subagent', arguments: {}, agent: child, callId: 'side-call', signal: new AbortController().signal });
    assert.equal(denied.isError, true);
    assert.equal(subagentCalls, 0);
    const allowed = await tools.execute({ name: 'subagent', arguments: {}, agent: parent, callId: 'main-call', signal: new AbortController().signal });
    assert.equal(allowed.isError, false);
    assert.equal(subagentCalls, 1, 'the side guard must not restrict the main chat');

    const replay = await rpc('open', { parentSessionId: parent.id, requestId: 'first-open' });
    assert.equal(replay.value.childId, childId);
    const second = await rpc('open', { parentSessionId: parent.id, requestId: 'second-open' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(second.value.childId, childId);
    assert.equal(second.value.index, 2);
    const nested = await rpc('open', { parentSessionId: childId, requestId: 'nested' });
    assert.equal(nested.error.code, 'side-chat/nested');
    assert.equal((await rpc('attach', { parentSessionId: parent.id, childId, clientId: 'fixture-window' })).ok, true);
    assert.equal((await rpc('attach', { parentSessionId: 'wrong', childId })).error.code, 'side-chat/wrong-parent');
    assert.equal((await rpc('close', { childId })).ok, true);
    assert.equal((await rpc('close', { childId })).ok, true, 'closing an already-ended side chat is idempotent');
    assert.equal(root.get('agents').get(childId), undefined);
    assert.equal(root.get('sessions').get(childId), undefined);
    assert.equal((await rpc('attach', { parentSessionId: parent.id, childId, clientId: 'fixture-window' })).error.code, 'side-chat/expired');
    assert.ok(root.get('agents').get(second.value.childId), 'closing one side chat preserves its sibling');
    const siblingId = second.value.childId;
    await rpc('attach', { parentSessionId: parent.id, childId: siblingId, clientId: 'window-a' });
    await rpc('attach', { parentSessionId: parent.id, childId: siblingId, clientId: 'window-b' });
    async function hold(clientId) {
      const request = Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: clientId, method: 'hold', payload: { clientId } }))]);
      request.url = '/side-chat/hold'; request.method = 'POST'; request.headers = { 'content-type': 'application/json' };
      const response = new EventEmitter();
      response.writeHead = () => {};
      response.end = () => {};
      route.handler(request, response);
      await new Promise((resolve) => setImmediate(resolve));
      return response;
    }
    const windowA = await hold('window-a');
    const windowB = await hold('window-b');
    windowA.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(root.get('agents').get(siblingId), 'another window still owns this side chat');
    windowB.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(root.get('agents').get(siblingId), undefined, 'last browser disconnect disposes the transient Agent');

    const pendingOpen = rpc('open', { parentSessionId: parent.id, requestId: 'cancelled-open' });
    const cancellation = rpc('cancel-open', { requestId: 'cancelled-open' });
    const cancelled = await pendingOpen;
    assert.equal((await cancellation).ok, true);
    assert.equal(root.get('agents').get(cancelled.value.childId), undefined);
    assert.equal(parent.status, 'idle');
    const diskAfter = await readdir(persistenceRoot, { recursive: true });
    assert.ok(!diskAfter.some((name) => name.includes(childId) || name.includes(siblingId)), JSON.stringify(diskAfter));

  } finally {
    await root.fiber.dispose();
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});
