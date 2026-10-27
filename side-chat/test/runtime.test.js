import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sideChat from '../index.js';

const runtimeRoot = process.env.DSH_RUNTIME_ROOT;

test('native DSH fork, request synchronization, dedicated rules, and committed cursor', {
  skip: runtimeRoot === undefined ? 'Set DSH_RUNTIME_ROOT to an unpacked DSH runtime to run integration checks' : false,
  timeout: 10000,
}, async () => {
  async function load(name) {
    return import(pathToFileURL(resolve(runtimeRoot, 'node_modules', '@deepseek-ai', name, 'lib/index.js')));
  }
  const [
    { Context }, { default: Sessions }, { default: Agents }, { default: AgentLoop },
    { default: SystemPrompt }, { default: Projections }, { default: Query },
    { default: Tools }, { default: Llm, LlmAdapter, createUserMessage }, Persistence, { default: SandboxPolicy },
  ] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt',
    'dsh-session-projection', 'dsh-session-query', 'dsh-tools', 'dsh-llm', 'dsh-session-persistence-jsonl', 'dsh-sandbox-policy',
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
  let failParentRead = false;
  class FixtureQuery extends Query {
    observeSession(id, options) {
      if (failParentRead && id === 'fixture-parent') {
        throw new Error('fixture read failure');
      }
      return super.observeSession(id, options);
    }
  }
  root.plugin(FixtureQuery, {});
  const persistenceRoot = await mkdtemp(resolve(tmpdir(), 'side-chat-runtime-'));
  await root.plugin(Persistence, { root: persistenceRoot, compression: 'none', listConcurrency: 1 }).await();
  root.inject(['sessionPersistence'], (scope) => {
    scope.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 });
  });
  root.plugin({ name: 'fixture-services', inject: ['llm'], apply(ctx) {
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
    const opened = await rpc('open', { parentSessionId: parent.id });
    assert.equal(opened.ok, true);
    let child = root.get('agents').get(opened.value.childId);
    assert.equal(child.session.header.parentSession, parent.id);
    assert.equal(root.get('sandboxPolicy').resolve({ session: child.session }).mode, 'read-only');
    assert.deepEqual(child.session.deriveMessages(), parent.session.deriveMessages());
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fresh parent detail' }] }));
    await parent.whenIdle();
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'side question' }] }));
    await child.whenIdle();
    const sideRequest = requests.at(-1);
    assert.equal(sideRequest.sessionId, child.id);
    const update = sideRequest.messages.find((message) => message.source.kind === 'side-chat:sync');
    assert.ok(update, 'a sync message must reach the real model request');
    assert.match(JSON.stringify(update), /fresh parent detail/);
    assert.match(JSON.stringify(sideRequest.messages[0]), /侧聊行为规则/);
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'another side question' }] }));
    await child.whenIdle();
    assert.equal(requests.at(-1).messages.filter((message) => message.source.kind === 'side-chat:sync').length, 1);
    const attached = await rpc('attach', { parentSessionId: parent.id, childId: child.id });
    assert.equal(attached.ok, true);
    assert.deepEqual(attached.value.inheritedTurns, [1]);

    // A stale binding must recover its cursor from committed log records.
    assert.equal((await rpc('detach', { childId: child.id })).ok, true);
    assert.equal((await rpc('attach', { parentSessionId: parent.id, childId: child.id })).ok, true);
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after refresh' }] }));
    await child.whenIdle();
    assert.equal(requests.at(-1).messages.filter((message) => message.source.kind === 'side-chat:sync').length, 1);

    // A sync failure must block the provider and preserve the human question.
    const beforeFailure = requests.length;
    failParentRead = true;
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'keep this question' }] }));
    await child.whenIdle();
    assert.equal(requests.length, beforeFailure);
    assert.match(errors.at(-1).message, /增量同步失败/);
    const queued = child.inbox.nextTurn.find((message) => JSON.stringify(message.content).includes('keep this question'));
    assert.ok(queued);
    failParentRead = false;
    child.inbox.clear();
    child.followup(queued);
    await child.whenIdle();
    assert.equal(requests.length, beforeFailure + 1);
    assert.equal(requests.at(-1).messages.filter((message) => message.source.kind === 'side-chat:sync').length, 1);

    // Exercise the actual JSONL cold-read and Agent.resume path, including presets.
    const childId = child.id;
    assert.equal((await rpc('detach', { childId })).ok, true);
    await handles.get(childId).dispose();
    assert.equal(root.get('agents').get(childId), undefined);
    const coldAttach = await rpc('attach', { parentSessionId: parent.id, childId });
    assert.equal(coldAttach.ok, true, JSON.stringify(coldAttach));
    child = root.get('agents').get(childId);
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after cold resume' }] }));
    await child.whenIdle();
    assert.equal(requests.at(-1).sessionId, childId);
    assert.equal(requests.at(-1).messages.filter((message) => message.source.kind === 'side-chat:sync').length, 1);

    // Opening twice cannot create two forks, and parent work is never awakened.
    const reopened = await Promise.all([
      rpc('open', { parentSessionId: parent.id }),
      rpc('open', { parentSessionId: parent.id }),
    ]);
    assert.ok(reopened.every((result) => result.ok && result.value.childId === child.id));
    assert.equal(parent.status, 'idle');
  } finally {
    await root.fiber.dispose();
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});
