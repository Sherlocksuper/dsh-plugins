# Host 侧临时会话（不进工作区列表）+ 隐藏上下文注入

基准：DSH **0.2.1-rc.3**（`<DSH_INSTALL>/`，下文行号均指该目录下 `node_modules/@deepseek-ai/<pkg>/lib/*.js`，已导出到 `<SRC>`）。

只读调研，另附插件 Host 半的实现依据 `side-chat/index.js`。未安装、未启用、未改 profile、未动 `client.js`。

---

## 0. 结论先行

**`fork + archive` 的替代方案是：Host 用 `ctx.agents.create` 建一个 `meta.origin = "subagent"` 的真实 Agent/Session，客户端用 `ctx.sessions.retain({parentSessionId, childSessionId, mode:"continuable"})` 渲染它的 transcript，但发送/停止/关闭走插件自己的 Host RPC 通道（`ctx.connection.rpc.handle`），不经过框架的 `session.prompt`，也不经过 subagent manager。**

四个关键结论（每条都能用代码行号证实，见正文）：

1. **"不 attach 到 workspace" 并不等于"不出现在左侧列表"。** 不属于任何 workspace 的会话会作为 `Ungrouped` 组里的一行出现（`ui-workspace/lib/client.js:1043`）。真正把一行从左侧列表里抹掉的条件只有一个：`session.header.origin === "subagent"`（`ui-workspace/lib/client.js:964-974`），而 header 的 `origin` 只允许 `"subagent"` 这一个值（`dsh-session/lib/index.js:1053`）。所以侧栏会话**必须**带 `origin:"subagent"` + `parentSession:<主会话 id>`。
2. **`ctx.sessions.retain` 可用，但只能走 subagent 地址。** 会话会进客户端 catalog（`origin/parentSessionId` 都在 summary 里，`api-session-controller/lib/index.js:1959-2005, 2127-2133`），客户端 `resolveTarget` 能从 catalog 反推出 subagent 地址（`client.js:3021-3036`）。随后历史流走 `session/follow({address:{kind:"subagent",…}})`（`client.js:429-433, 2923-2936`），Host 校验需要：`origin==="subagent"`、`header.parentSession===地址里的 parent`、且会话日志里有**合法 `subagent/descriptor`**（`index.js:1691-1711`），另外 `header.cwd` 必须存在（`index.js:1638-1641`）。所以 Host 建会话时要在 setup 里补一条 `subagent/descriptor`。
3. **不能指望框架的发送链路。** `origin==="subagent"` 的会话被 `hasApiSessionSubagentOwner` 判给 subagent 路由（`index.js:128-142`、`365-369`、`1058-1067`），`session/prompt`、`session/cancel`、`resolveAgent` 全部被拒（`session/agent-busy`）。而客户端 `Session.prompt()` 看到地址就改走 `remote.subagents.prompt`（`client.js:2341-2385`），那条路会进 subagent manager 的 cold-resume；manager 在子会话每个 turn 结束时会向**父会话**注入一条 `subagent-settled` 通知（`dsh-subagent/lib/index.js:2048-2056` → `508-540`，Chat 会把它渲染成一张有边框的"Turn trigger"卡片 `ui-chat/lib/client.js:7042`）。这就是"侧聊污染主对话"的来源。**结论：侧栏的发送必须在插件自己的 Host 通道里对 `agent.followup` 直接调用，绕开这两条链路。**
4. **"关闭即丢弃"没有删除 API**（持久化层明确"无删除/保留 API"，见 §5），但 `origin:"subagent"` 已经保证它永远不出现在任何列表/搜索/归档筛选里；关闭动作 = dispose 掉 Agent + 客户端释放 reference。会话 JSONL 仍留在磁盘上（不可见、不可恢复入口），这是本方案能达到的真实语义。

推荐架构（Host 半已写成草稿）：

```
Client（侧栏 tab）
  ├─ open:   ctx.connection.rpc.call('/side-chat','open',{parentSessionId, childId?})
  │            → Host: agentPresets.composeFrom / ctx.agents.create({meta:{cwd,parentSession,origin:'subagent',agentPreset}})
  │            → setup: subagent/descriptor + 沙箱/审批 knob
  │            → agent.inject(隐藏上下文 user/message)
  ├─ 渲染:   ctx.sessions.retain({parentSessionId, childSessionId, mode:'continuable'})
  │            → session/follow(subagent 地址)（只读 transcript，主对话历史不出现）
  ├─ 发送:   ctx.connection.rpc.call('/side-chat','send',{parentSessionId,text})
  │            → Host: agent.followup(UserMessage)          ← 不经 manager，无结算通知
  ├─ 停止:   ctx.connection.rpc.call('/side-chat','cancel',…)
  └─ 关闭:   ctx.connection.rpc.call('/side-chat','close',…)
               → Host: handle.dispose()（+ 客户端 reference.release()）
```

---

## 1. Q1：如何创建"未 attach 到任何 workspace"的 live Session，它到底会出现在哪

### 1.1 三个候选入口的差别

| 入口 | 能否控制 `origin` | 是否 attach workspace | 是否进客户端 catalog | 左侧列表 |
| --- | --- | --- | --- | --- |
| 客户端 `ctx.sessions.fork`（现状） | 否（`fork` 不设 origin） | 会自动 `workspace.attachSession` | 是 | **出现在所属 workspace 组** |
| 客户端 `ctx.sessions.create` | 否 | 请求里带 `workspaceId`/`cwd` | 是 | blank 时隐藏；首次 turn 后进 Ungrouped/workspace |
| **Host `ctx.agents.create` + `meta.origin:"subagent"`** | **能** | 不 attach | 是（summary 带 origin/parent） | **永不出现**（含归档筛选、搜索） |

`fork` 的实现就在 `api-session-controller/lib/index.js:883-909`：`ctx.agents.create({sessionId, seed, inheritedEventCount, meta:{cwd,parentSession,isSeeded,agentPreset}, agentOptions, setup})` 之后 `workspace.attachSession(childId)`。注意它用 `seed`（父日志前缀）+ `isSeeded:true` —— 这正是"侧栏会显示主对话历史"的原因（seed 事件进子会话 transcript）。**我们要的是 `isSeeded:false` + 不做 `attachSession` + 手动设置 `origin`。**

### 1.2 (a) 不带 origin、不 attach workspace，真的不出现在工作区列表吗？—— 不成立

左侧列表的分组逻辑（`ui-workspace/lib/client.js:1027-1046`）：

```js
function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
  const current = mainSessionId(list);
  const groups = [];
  const accounted = new Set();
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) { …, accounted.add(id), … }
  }
  // 关键：不属于任何 workspace 的会话作为 "stray" 收进 Ungrouped 组
  const stray = list.ids.map((id) => list.byId[id])
    .filter((s) => s !== undefined && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
  if (stray.length > 0) groups.push(buildGroup('', undefined, undefined, undefined, '', orderedUngrouped(stray, …)));
  return groups;
}
```

`sessonVisible` 才是唯一的隐藏闸门（`ui-workspace/lib/client.js:964-974`）：

```js
function sessionVisible(session, current, archived, archivedFilter) {
  if (session.origin === "subagent") return false;          // ← 唯一的“永不显示”
  if (session.blank && session.id !== current) return false; // 临时占位，首轮后失效
  switch (archivedFilter) { … }                              // 归档筛选，挡不住搜索/其它入口
}
```

也就是说：
- 只是"不 attach workspace" → 会话出现在 **Ungrouped** 组（正是主对话若没有 workspace 时自己也待的地方）；
- `blank` 只能撑到第一次 `turn/start`（`api-session-controller/lib/index.js:1933-1957` 的 `summaryFor` → `blank: metadata?.blank ?? session.seq === 0`）；
- 归档（archive）虽然能隐藏，但 `ArchivedSessionGate` 监听 `agent/pre-step` 直接 reject 模型步骤（`api-session-controller/lib/types/archived-session-gate.js:17-25`），会话"不能聊"，这就是实测里"archive 之后 agent 不再跑"的原因。

**所以：必须 `meta.origin:"subagent"`。** header 校验只接受这个值（`dsh-session/lib/index.js:1051-1053`）：

```js
if (record.parentSession !== void 0 && typeof record.parentSession !== "string") throw …
if (typeof record.isSeeded !== "boolean") throw …
if (record.origin !== void 0 && record.origin !== "subagent") throw new Error('session header origin must be "subagent"');
```

`meta` → header 的映射在 `dsh-session/lib/index.js:1823-1827`（`cwd / parentSession / isSeeded / origin / delegationDepth / agentPreset`），`delegationDepth` 不传就是顶层深度。

### 1.3 (b) 客户端 `ctx.sessions.retain` 可用吗？—— 可用，但走 subagent 地址，且必须补 descriptor

链路逐段：

1. **Host catalog 含这条会话。** `ApiSessionList.list()` 遍历 `sessionQuery.listSessions()`：live 会话无条件入列（`index.js:1959-1988`），冷会话要求 `header.cwd !== undefined`（`index.js:1967-1969: else if (record.header.cwd !== void 0) cold.push(record)`）。summary 带 `origin`/`parentSessionId`（`listFields`，`index.js:2127-2133`）。
2. **客户端 catalog 含这条会话。** 远端 `session/list` 直接返回这些 items（`index.js:3061-3066`），客户端 ProjectList 把 `origin`/`parentId` 写进行数据（`client.js:4160-4175`）。
3. **`retain` 解析地址。** `retain(target)` → `manager.resolveTarget`（`client.js:3007-3014`）：

```js
resolveTarget(target) {
  const id = typeof target === "string" ? target : target.childSessionId;
  const address = typeof target === "string" ? this.subagentAddress(id) : target;
  if (typeof target === "string" && !this.sessions.has(id) && !this.summaries.some((s) => s.sessionId === id) && address === void 0)
    throw new Error(`sessions.retain: unknown session ${id}`);
  if (address !== void 0) this.addresses.set(id, address);
  this.sessions.get(id)?.configureSubagent(address, …);
  return id;
}
```

`subagentAddress`（`client.js:3021-3036`）在 `summary.origin === "subagent"` 且 `parentSessionId` 存在时返回 `{parentSessionId, childSessionId, mode:"unknown"}`；显式传地址时以传入的 `mode` 为准。**建议客户端直接传显式地址**，`mode:"continuable"`：

```js
const reference = ctx.sessions.retain(
  { parentSessionId, childSessionId: childId, mode: 'continuable' },
  { source: 'sideChat', signal },
)
```

4. **历史流。** `Session` 打开时把地址交给 `SessionEventStream`，统一调用 `remote.session.follow({address, assistantStream:true, …})`（`client.js:2668-2672`, `429-433`）；地址由 `sessionAddress()` 决定（`client.js:2923-2936`）：有地址 → `{kind:"subagent", …address}`；无地址 → `{kind:"session", sessionId}`。
5. **Host 侧校验**（`index.js:1631-1653` + `1691-1711`）：

```js
async sourceFor(address, signal, withProjections) {
  const observation = await this.ctx.sessionQuery.observeSession(sessionId, {…});
  if (observation.header.cwd === void 0) { …; rejectNotFound(address); }   // ← cwd 必须存在
  validateAddress(address, observation.header, observation.inheritedEventCount, observation.projections);
  …
}
function validateAddress(address, header, inheritedEventCount, projections) {
  if (address.kind === "session") {
    if (header.origin === "subagent") throw new RemoteError("session/agent-busy", "subagent Sessions require their durable parent address", …);
    return;
  }
  if (header.origin !== "subagent" || header.parentSession !== address.parentSessionId)
    throw new RemoteError("subagent/unauthorized", "subagent does not belong to the supplied parent", …);
  const identity = projections?.values.subagent;
  if (identity === null) throw … "corrupt";
  if (identity === void 0 || identity.seq < inheritedEventCount) throw … "descriptor is unavailable";
  if (address.mode !== "unknown" && identity.mode !== address.mode) throw … "subagent mode does not match";
}
```

`projections.values.subagent` 来自子会话日志里的 `subagent/descriptor` 事件（投影 `subagentIdentityProjectionDefinition`，`dsh-subagent/lib/index.js:2731-2750`；描述符格式 version 3，continuable 必需字段 `version/mode/provider/label`，可选 `agentProvider/agentModel/agentReasoningEffort/persona/toolFilter`，见 `571-620` 与 `626-664`）。

**因此 Host 建会话时必须在 setup 里 append（草稿已实现）：**

```js
child.session.append('subagent/descriptor', {
  version: 3, mode: 'continuable', provider: 'spawn', label: '侧栏对话',
  agentProvider: route.provider, agentModel: route.model,   // 可选，便于别人 cold-resume 时复原
})
```

> `provider: 'spawn'` 是本部署里真实注册的 in-process provider 名（`dsh-subagent-spawn-in-process/lib/index.js:17, 21-29`；另一个是 `fork`，`dsh-subagent-fork-in-process`）。我们自己的链路不用 manager，写它只是为了 descriptor 合法、且万一被 manager cold-resume 时行为可预期。

⚠️ 少了 descriptor → `retain` 打开时会以 `subagent/catalog-diagnostic: descriptor is unavailable` 失败（地址校验），不是"白屏"而是 follow 报错。

### 1.4 (c) 关掉浏览器之后它会出现在任何 UI 吗？—— 不会

- **左侧列表**：`origin==="subagent"` 第一优先级 return false，与归档筛选/搜索无关（`ui-workspace/lib/client.js:964-974`；搜索同样走 `sessionVisible`，`client.js:1185, 1200`）。
- **归档筛选**：同样被 origin 挡住；它也不会进 `archivedSessionIds`（我们从不 archive）。
- **孤儿/未分组**：Ungrouped 也只收 `sessionVisible` 为真的会话，同样被挡。
- **"New Session"占位**：不会，它不是 blank 语义的那一个。
- **主对话的 subagent 面板**：不会。那个面板读父会话的 `subagent/catalog` 投影（`dsh-subagent/lib/index.js:792-840`），我们**不**往父会话 append catalog 事件（草稿有意不做），所以父会话的 subagent 目录里看不到它。
- **但它确实存在于**：`sessionQuery.listSessions()` 的返回、客户端 `ctx.sessions.list` store 的 `byId` 里（一个 `origin:"subagent"` 的隐藏行）、磁盘 JSONL、以及搜索索引里（只是所有 UI 都按 origin 过滤）。客户端 `projectList` 还会为任何带 subagent 地址的 retained scope 生成一行（`client.js:4196-4225`），同样被 origin 过滤。

一个额外注意点：归档门会沿 `origin:"subagent"` 的父链向上找（`archived-session-gate.js:35-50`），所以**主会话被归档时，侧栏会话的模型步骤也会被挡住**（符合直觉，但要在产品文档里写清）。

---

## 2. Q2：`ctx.agents.create` 的准确参数与"复刻父会话"

### 2.1 调用面与返回值

`ctx.agents` 是 `AgentRegistry`（`dsh-agent/lib/types/index.js:35-70`），创建委托给 agent-loop 的 factory：

- `create(options)` → `factory.createAgent(ownerCtx, options)`（`dsh-agent/lib/types/index.js:166-183`，注释明确 "The resolved `AgentHandle` lets the owner tear down exactly this agent"）。
- `agent-loop` 的 `createAgent(ownerCtx, options)` destructure（`dsh-agent-loop/lib/index.js:1893-1910`）：
  `sessionId`、`seed`、`meta`、`inheritedEventCount`、`agentOptions`、`setup`、`signal`、`parentAgent`。
- 返回值是 `AgentHandle`：`{ agent, dispose }`（`publish()` 返回 `{agent, dispose}`，`agent-loop/lib/index.js:1780-1804`）。**`dispose()` 必须由我们保存并在关闭/卸载时调用**——`ownerCtx` 是 AgentRegistry 自己的 context（`dsh-agent/lib/types/index.js:170`），不是我们插件的 fiber，插件卸载不会自动带走它。
- `meta` 字段白名单见 §1.2 末尾（`dsh-session/lib/index.js:1823-1827`），`cwd` 必须是绝对路径。

### 2.2 preset / composition 怎么拿

`agentPresets` 服务（`dsh-agent-preset-registry`）提供了三个正好够用的方法（`lib/index.js:686-716`）：

```js
const presets = ctx.get('agentPresets')
presets.composedPreset(parent.ctx)          // parent 当前绑定的 preset id（可能 undefined = 无 preset 组成）
await presets.mount(childCtx, presetId)     // 把子 Agent 绑到该 id 的当前 revision（异步）
presets.composeFrom(childCtx, parent.ctx)   // 子 Agent 加入父“完全相同的 revision”（同步，无 preset 时是 no-op）
```

这两步就是 subagent 包里 `applyChildComposition` 的做法（`dsh-subagent/lib/index.js:373-395`）。另外两个容易看错名字的方法：`presetForObservation(observation)` / `presetForSession(session)` 是 **api-session-controller 的方法**（`dsh-api-session-controller/lib/index.js:332-345` 与 `:536-558`，用于 fork/冷会话从投影读 preset），不在 preset registry 上、我们也不需要——父 Agent 是 live 的，`composedPreset(parent.ctx)` 直接给答案；`mount` 的返回是 `{id}`。

注意：`create` 时把 `agentPreset` 写进 `meta`（进 header），`agentPreset` 投影以 header 为初值（`registry/lib/index.js:49-56`），客户端模型选择器/预设徽标才有得显示。resume 时读 `child.session.header.agentPreset` 再 `mount`（草稿的 `applyParentComposition`）。

### 2.3 模型 / cwd / 权限策略

- **模型**：取父会话**上一次请求头**（比 `parent.options` 新；后者只是创建时路由）：`parent.session.requestHeader()?.config` → `{provider, model, reasoningEffort}`；没有请求头时退回 `ctx.get('agentDefaultModel').currentSelection()`。这等价于 subagent 包 `parentAgentOptionsForDelegation` 的思路（`dsh-subagent/lib/index.js:289-315`）。
- **cwd**：`parent.session.header.cwd`；父会话由 cwd 直开时可能没有 header.cwd，用 `ctx.get('workingDirectory').get(parent.session)`（投影初值就是 header.cwd，缺省时给 `defaultDirectory`，`dsh-working-directory/lib/index.js:38-45, 72-78`）。**不能省略**：没有 cwd 的会话既不能 follow（§1.3）也不出现在冷 catalog（`index.js:1967-1969`）。
- **权限策略**：直接 append 父会话的**有效 knob**，让子会话可复现：
  - `sandboxPolicy.overrideOf(parent.session)` → `child.session.append('sandbox/mode', { mode, source:'delegation' })`（事件形状见 `dsh-sandbox-policy/lib/index.js:41, 119`）；
  - `approval.effectivePolicy(parent.session)` → `child.session.append('approval/policy', { policy })`（`dsh-user-approval/lib/index.js:63-65, 149-165`）；
  - 可选：`permissionPresets.current(parent.session)`，但 knob 已经决定 `current()` 的推导结果（`dsh-permission-presets/lib/index.js:87-95, 291-302`），草稿只写 knob，少一条会漂移的事件。
  - 若照抄 subagent 的 delegation 语义，它会把 approval 钉成 `"never"`（`dsh-subagent/lib/index.js:408-420`）。**侧栏是人类在用的对话，别照抄**，否则工具审批一律 fail-closed。

### 2.4 可运行骨架（节选自草稿，`side-chat/index.host-draft.js:167-219`）

```js
import { randomUUID } from 'node:crypto'

const handle = await ctx.agents.create({
  sessionId: childId,                       // `session-${randomUUID()}`
  agentOptions: route,                      // {provider, model, reasoningEffort?}
  meta: {
    cwd,                                    // 父会话 cwd（绝对路径，必须）
    parentSession: parentSessionId,
    isSeeded: false,                        // 不复制父日志 → 侧栏看不到主历史
    origin: 'subagent',                     // 左侧列表隐藏的唯一开关
    ...(presetId === undefined ? {} : { agentPreset: presetId }),
  },
  setup: async (childCtx, child) => {
    await applyParentComposition(childCtx, child, parent)   // mount / composeFrom
    child.session.append('subagent/descriptor', descriptor) // 客户端 retain 的通行证
    // 跨重启认领靠 descriptor.label 常量（见 §5 第 5 条），不额外写插件事件
    if (sandboxMode !== undefined) child.session.append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
    if (approvalPolicy !== undefined) child.session.append('approval/policy', { policy: approvalPolicy })
  },
})
// handle = { agent, dispose }
handle.agent.inject(hiddenContextMessage)   // 见 §3
```

### 2.5 两个容易踩的坑

1. **Host 半不能 `import` 任何 `@deepseek-ai/*` 包**（插件是 workspace 目录，Node 解析不到 app 的 `node_modules`；且 `research/bundle-format.md §1.3` 已明确此约束）。所以 `childSessionMeta` / `snapshotSubagentDescriptor` / `captureDelegatedPolicyOverrides` 这些导出函数**用不上**，必须按上面的字段手写等价逻辑。这是"内部/未导出方式"之外的一条硬约束，草稿遵守了它（只用 `node:crypto`）。
2. **不要给 `create` 传 `parentAgent`。** 传了只影响 `ctx.agents.enter(agent, parentAgent)` 记录的 runtime owner（`agent-loop/lib/index.js:1791`），用于 `agents.isOwnedBy()`；它既不负责父销毁时连带销毁（真正做这件事的是 subagent manager 的 `drainDescendants`），又会让我们和 subagent 路由的 ownership 判定纠缠。自己管 `dispose` 更清楚。

---

## 3. Q3：隐藏上下文注入（模型能读到、Chat 不显示）

### 3.1 Chat 到底隐藏什么

`isVisibleChatNode`（`ui-chat/lib/client.js:8200-8202`，README "Hidden Chat rows"，`README.md:51`）：

```js
return node.visibility === "visible"
  && node.kind !== "system-prompt"
  && (node.kind !== "context" || node.data.content.some((b) => b.type === "tool-addition" || b.type === "tool-removal"))
  && !(node.kind === "command" && node.data.name === "permission");
```

而"`user/message` 变成 `context` 节点"的规则在 `messageDefinition.start`（`ui-chat/lib/client.js:9853-9890`）：**只要 `event.data.source.kind !== "user"`，就归类为 `context`**（`contextMessage`，`9832-9845`）。所以：

- `source.kind === "user"` → 用户气泡（可见）；
- 任何其它 `source.kind` → Context 行（普通文本内容 → **在所有 work-details 模式下都不渲染**，`ui-chat/README.md:51`）。

### 3.2 `UserMessage` 的准确结构

dsh-session 的事件校验（`dsh-session/lib/index.js:1194-1230`，`assertMessageEventShape`）对 `user/message` 只要求：

```js
{ id: string(非空), role: "user", source: { kind: string(非空), ...任意 }, content: [...] }
```

`createUserMessage` 本身只是 `deepFreeze(structuredClone({...input, id: randomUUID()}))`（`dsh-llm/lib/index.js:41-63`），没有额外字段。所以 Host 半自己造一个合法对象即可（不能 import `createUserMessage`）：

```js
{
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: digest }],
  source: { kind: 'side-chat:context' },   // ← 非 "user" ⇒ Chat 归为 context ⇒ 隐藏
}
```

### 3.3 五种注入位置对比（推荐 ①）

| # | 位置 | 何时进模型上下文 | Chat 可见性 | 持久性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| ① | `agent.inject(message)`（草稿采用） | 进入 `next-step` inbox，**不唤醒**；用户第一次发问的那一 turn 的 step 1 与用户消息一起被 claim（`agent-loop/lib/index.js:103-110` claim 先清空 next-step），随后作为 `user/message` 落日志（`agent-loop/lib/index.js:1063-1073`） | 隐藏（context 节点） | 落日志后持久 | 位置最自然（在用户首条消息之前、同一 step 内）；用户若从不发消息则一直 pending，dispose 时丢弃 |
| ② | setup 里 `child.session.append('user/message', msg, {surfaceOp:'append'})` | 建会话时即落日志，第一请求就带上 | 隐藏 | 持久 | 位置在 `turn/start` 之前，UI 节点没有 turn 归属（虽然被隐藏，仍建议 ①） |
| ③ | `childCtx.systemPrompt.context({name,order,text})` | 每次请求的 runtime-context 段（`agent-loop/lib/index.js:1063-1073` 把它 project 成 `runtime-context` 的 user/message） | 隐藏 | 仅当次进程/Agent scope | **每 step 重发**，长摘录会持续烧 token；Agent dispose 后丢失（resume 时 setup 会重跑，可接受） |
| ④ | `childCtx.systemPrompt.section({name,order,text})` | 进 system prompt | 隐藏（system-prompt 行本来就被 `isVisibleChatNode` 挡掉） | 同上 | 适合固定行为说明（"你在一个临时侧栏对话里"），不适合放会变的历史摘录 |
| ⑤ | 直接当第一条 prompt 发给模型 | 立即 | **可见的用户气泡** | 持久 | 不可接受（等于把主对话历史铺在侧栏里） |

草稿只实现了 ①（`buildDigest` + `agent.inject`，见 `index.host-draft.js:211-221, 398-451`）。摘要算法：倒序取 `parent.session.deriveMessages()` 里 `role:user, source.kind:"user"` 与 `role:assistant, source.kind:"model"` 的文本，单条截断 1200 字符、总量截断 12000 字符，加一段"这是隐藏背景、不是当前用户发言"的前言。需要"完整历史"时把 `MAX_DIGEST_CHARS` 调大即可（token 成本同步上升）。

> 注意 `deriveMessages()` 返回的是带 `source` 的完整消息对象（`dsh-session/lib/index.js:217-230, 555-559`），所以能筛掉 runtime-context / tool 结果；只取文本块。

---

## 4. Q4：Host→Client 通道对比与推荐

### 4.1 三个候选

| 方案 | 鉴权 | 副作用 | 评价 |
| --- | --- | --- | --- |
| **A. `ctx.connection.rpc.handle(channel, handler)` + 客户端 `ctx.connection.rpc.call(channel, endpoint, payload)`** | 走 Connection 的 `admit()`：Host/Origin fence + 浏览器签名 cookie / API token（`dsh-client-connection/lib/index.js:742-762`） | 无会话日志、无 UI 行 | **推荐**。这是 `/api` 同一套传输（HTTP POST + JSON envelope），只是换一个插件私有 channel |
| B. `ctx.webServer.register({kind:'exact', path, handler})` 裸路由 | **无鉴权**（webserver 是纯路由表，`dsh-host-webserver/lib/index.js:323-336`） | 无 | 只在必须绕开 Connection 时用；要自己校验 `Origin`/`Host`，本机其它进程仍可伪造 → 风险自担 |
| C. Host command（`ctx.commands.register`）+ 客户端 `ctx.remote.commands.execute` | 有（走 /api 的 owner peer） | 每次调用在**主会话日志** append `command/run` + `command/done`（`dsh-commands/README.md` "Lifecycle events"），Chat 会渲染 command 行（只有 `permission` 命令行被隐藏，`ui-chat/lib/client.js:8201`） | 可作为"没有 Connection 的 profile"的兜底；`send` 每条消息留一行 command 太脏 |

### 4.2 A 的确切写法（草稿实现）

Host：

```js
export const inject = ['agents', 'connection']

ctx.effect(
  () => ctx.connection.rpc.handle('/side-chat', (endpoint, payload, signal) => dispatch(...)),
  'side-chat: rpc channel',
)
```

- channel 规则 `^\/[A-Za-z0-9._~-]+$`、且不能用 `/api`（`dsh-client-connection/lib/index.js:689-690, 970-973`）；endpoint 段规则 `^[A-Za-z0-9_$.-]+$`（`:690`）。
- 注册实现：`rpc.handle` → `register(owner, channel, handler)` → `ctx.webServer.register({kind:'prefix', path: channel, handler})`，handler 内部先 `admit(req)`（Host/Origin + cookie/token），401/403 直接写回（`:855-883`）。**所以客户端同源 `fetch` 会带上登录 cookie，天然有鉴权**；桌面壳走的是 transport hook 的 IPC fetch（`client-connection/README.md` "the Host half always provides the carrier-neutral RPC"），同样可用。
- handler 返回值必须是 Connection 的 envelope（`rpcFetchHandler` → `fullResponse`，`:888-946`；客户端校验见 `client.browser.js:1288-1313`）：
  - 成功：`{ ok: true, value: <JSON> }`
  - 失败：`{ ok: false, error: { code: string, message: string, details: object } }`（三个字段都必需）

Client：

```js
const result = await ctx.connection.rpc.call('/side-chat', 'open', { parentSessionId })
if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
const { childId } = result.value
```

`call` 的实现是 `POST <channel>/<endpoint>`、`content-type: application/json`、body `{type:'client-request', rpcId, method, payload}`，返回 `full.result`（`client.browser.js:1212-1240`）。传输失败抛异常；业务失败在 `result.ok === false`。

### 4.3 RPC 接口契约（草稿已实现，客户端照此接）

| endpoint | payload | 成功 value | 失败码 |
| --- | --- | --- | --- |
| `open` | `{ parentSessionId, childId? }` | `{ childId, parentSessionId, resumed }` | `side-chat/parent-unavailable`（主会话不 live）、`side-chat/child-unavailable`（`childId` 无法 resume，客户端应改为不带 childId 重新 open）、`side-chat/cwd-unavailable` |
| `send` | `{ parentSessionId, text }` | `{ accepted: true }` | `side-chat/not-open`（宿主内存里没有它的 live 记录，需重新 open） |
| `cancel` | `{ parentSessionId }` | `{ accepted: true }` | 同上 |
| `close` | `{ parentSessionId }` | `{ closed: true }` | —（幂等） |

语义补充：
- **"一个主对话只允许一个侧栏对话"在 Host 侧强制**：`open` 以 `parentSessionId` 为 key 的 Map 去重，已有 live 记录就原样返回。
- `send` → `agent.followup(message)`（排队为下一 turn；运行中发送也是排队，等价于框架的 queue 模式）。
- `cancel` → `agent.cancel({kind:'user'}, {keepInbox:true})`，与框架 `session/cancel` 完全一致（`api-session-controller/lib/index.js:1061-1066`）。
- `close` → `handle.dispose()`；Map 删除；会话冷掉，日志留存但不可见。
- 崩溃/重启后：客户端把 tab 地址里的 `childId` 带回 `open`，Host 校验 `header.origin === "subagent"`、`header.parentSession === parent`、日志里第一条 `subagent/descriptor.label === LABEL` 之后用 `ctx.agents.resume(...)` 认领（`index.host-draft.js:229-286`）。**为什么用 descriptor.label 当标记**：插件自造 `plugin:*` 记录需要 `appendPluginRecord(session, type, data)` 才能带 `ignorable:true`（`dsh-session/lib/index.js:1295-1301, 1543-1566`），而我们把"Host 半不能 import `@deepseek-ai/*`"当硬约束（§2.5），拿不到该函数；直接 `session.append('plugin:...')` 写出的不是 ignorable 事件，持久化层读日志时会以 "unknown to this harness and not marked ignorable" 整份拒绝（`dsh-session-persistence/lib/index.js:184`），会话从此打不开——不能这么用。descriptor 是我们本来就要写的、字段受 `assertKnownKeys` 约束（`dsh-subagent/lib/index.js:626-664`），`label` 恰好是唯一能放常量的字段。

### 4.4 不推荐把 B 当主方案的理由

`webServer.register` 完全不看身份（`dsh-host-webserver/lib/index.js:1-30, 323-336`），虽然默认只绑 `127.0.0.1`（`dsh-web-app/cordis.patch.yml` 的 webserver 行），但任何本机页面都可以 CSRF POST（可以用 `Origin` 拦浏览器，拦不住本机进程）。A 已经免费拿到 Connection 的签名 cookie 鉴权，没有理由绕开。**B 的正确用途是降级兜底**：若某 profile 没挂 `connection`（CLI/ACP），Host 半可以退化成 `webServer` + `Origin` 白名单，或干脆不提供通道（侧栏功能仅 Web/Desktop）。

---

## 5. Q5：清理与"关闭即丢弃"的真实语义

1. **Host 侧关闭动作 = `handle.dispose()`**（`AgentHandle.dispose`，`dsh-agent/lib/types/index.js:176-210` + `agent-loop/lib/index.js:1703-1768` 的 teardown：cancel → whenIdle → scope dispose → 关闭 persistence handle → 从 registry 移除 → 发 `agent/disposed`）。之后会话是"冷"的。
2. **没有删除/保留 API**：
   - `session/*` 远端端点全集没有 delete/remove（`api-session-controller/lib/typert.remote-client.js`），`workspace/delete` 删的是 workspace 注册，不删会话/文件；
   - 持久化层明文："No deletion or retention API — pruning stored sessions is out-of-band backend maintenance."（`dsh-session-persistence/README.md:153`）
   - JSONL 后端明文："Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API."（`dsh-session-persistence-jsonl/README.md:167`）
3. **不需要 archive**：`origin:"subagent"` 已经让它从所有列表/搜索/归档筛选里消失（§1.4），archive 只会（a）把 id 塞进 `archivedSessionIds`，（b）给这个会话加 `pre-step` 拦截（对已关闭的会话无意义）。**尤其不能在"使用中"archive** —— 那正是当前实现翻车的地方（`archived-session-gate.js:17-25`）。
4. **客户端侧**：resource provider 的 `finally` 里 `reference.release()`，并在 `close` RPC 成功后从侧栏布局移除 tab（Tab 记录持久化在 `dsh.sidebar-right.v1.<sessionId>` localStorage，见 `research/sidebar-side-chat.md §4`）。
5. **残留清理（可选）**：重启后 Host 内存里的 Map 是空的，老的侧栏 child 若没有 tab 再引用，就是"不可见的孤儿"——只占磁盘。如果嫌脏，可以在插件启动时做一次扫描：`sessionQuery.listSessions()` 里 `origin==="subagent"`、`header.parentSession` 指向的父会话不存在/不活跃、且自己日志里的 `subagent/descriptor.label === "侧栏对话"` 的会话 → `workspaceRegistry` 归档（仅作簿记）或什么都不做。**不要手删 JSONL**（破坏 writer lock / 投影缓存 / 搜索索引，`dsh-session-persistence/README.md` 的 out-of-band 警告）。
6. **进程退出**：插件 fiber 卸载时 `ctx.effect` 的 teardown 会 dispose 所有 live side agent（草稿 `index.host-draft.js:57-66`）；Host 进程被杀时 Agent 直接消失，会话日志（若已 flush）重启后可 resume。

---

## 6. Q6：风险清单

### 6.0 本方案用到的 API 稳定性分级

| 用的东西 | 性质 | 证据 | 风险 |
| --- | --- | --- | --- |
| `ctx.agents.create / resume / get` | Cordis 服务公开面（Host） | `dsh-agent/lib/types/index.js:176-210` | 低 |
| `AgentHandle.dispose` | `create/resume` 的返回值 | `agent-loop/lib/index.js:1780-1804` | 低 |
| `agent.followup / cancel / inject` | Agent 运行时接口（多个随包插件直接使用） | `agent-loop/lib/index.js:806-814`；`dsh-subagent`、`dsh-working-directory` 都在用 | 低-中（未从 `@deepseek-ai/dsh-agent` 导出类型，但属稳定运行时面） |
| `session.append('subagent/descriptor', …)` | 公共 `append` + **dsh-subagent 包事件 schema** | `dsh-session/lib/index.js:1517-1544`；`dsh-subagent/lib/index.js:571-664` | 中：descriptor 版本升级会失效（R2） |
| `session.header` 的 `origin/parentSession/cwd` | Session 格式公开字段（持久化 header v4） | `dsh-session/lib/index.js:1051-1053, 1823-1827` | 低 |
| `meta.origin` 写 `"subagent"` | 同上（唯一允许的 origin 值） | 同上 | 低-中：框架可能新增 origin 语义 |
| `agentPresets.composeFrom / mount / composedPreset` | agent-preset-registry 服务公开方法 | `dsh-agent-preset-registry/lib/index.js:686-733` | 低 |
| `sandboxPolicy.overrideOf` / `approval.effectivePolicy` | 权限相关服务公开方法 | `dsh-sandbox-policy/lib/index.js:154-160`；`dsh-user-approval/lib/index.js:152-165` | 低 |
| `sessionQuery.observeSession` | Host 服务公开方法（返回可 dispose 的 lease） | `dsh-session-query/lib/index.js:1064-1068`；lease 形状 `:450-480`（`[Symbol.dispose]` 在 `:467`） | 低 |
| **`ctx.connection.rpc.handle`** | 包内公开方法、**README 未文档化**（README 只写了 `/api` 的 Fetch 通道） | `dsh-client-connection/lib/index.js:725-734, 855-883` | **中-高：R1**，升级时优先检查 |
| 客户端 `ctx.connection.rpc.call` | 同上（browser 侧通用 RPC 客户端） | `client.browser.js:1212-1240` | 中-高（同上） |
| `ctx.sessions.retain({parentSessionId, childSessionId, mode})` + `session/follow` | 客户端 session controller 公开面，wire 地址 schema 有严格定义 | `client.js:3007-3036`；`typert.host.js:239-252`（address 联合类型） | 低 |
| 自造隐藏上下文 `user/message`（非 `user` source） | 依赖 Chat 的 `isVisibleChatNode` 判据 | `ui-chat/lib/client.js:8200-8202`；`README.md:51` | 中：隐藏规则可能变（R2 同类） |

**没有用到的"内部捷径"**（明确不推荐）：`workspaceRegistry` 直接改 `archivedSessionIds`、手删 JSONL、`appendPluginRecord`（不可 import）、subagent manager 的 `startActivation`（会带一条可见初始 prompt + 结算通知，见 §0 第 3 条）。

### 6.1 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | `ctx.connection.rpc.handle` 是包内公开方法但 README 未文档化（只文档了 `/api` 的 intercept 语义） | 升级后签名可能变（`(channel, handler)` / envelope 形状） | 锁版本；Host 半集中在 `index.host-draft.js` 一个文件，替换成本低；备选方案 B/C 已给出 |
| R2 | `subagent/descriptor` 的 version 是硬编码 3（`dsh-subagent/lib/index.js:571`），格式变了我们的合成 descriptor 就失效 | 客户端 `retain` 打不开侧栏（`subagent/catalog-diagnostic`） | 升级时跟进 `SUBAGENT_DESCRIPTOR_VERSION` 与 `parseSubagentDescriptor`；`isVisibleChatNode` 等客户端判据同理 |
| R3 | 会话被 `origin:"subagent"` 打了标记，框架会把所有 "subagent 路由" 的特判套到它身上（`hasApiSessionSubagentOwner`、`updateQueue` 的 continuable 检查等） | 任何试图用 `session/prompt`/`session/cancel`/`session.updateQueue` 操作它的代码都会 `session/agent-busy` | 我们自己的 RPC 只暴露 `send/cancel/close`；客户端绝不能对侧栏会话调 `ctx.sessions.prompt`/标准 composer |
| R4 | 若客户端误用标准 composer → 走 `subagents.prompt` → manager cold-resume（我们持有 writer 时直接失败；我们能 dispose 时能跑起来但**每个 turn 会往主对话注入 `subagent-settled` 卡片**） | 侧聊污染主对话 | 客户端必须替换 `conversation.composer` chain（或只渲染 transcript），见 §7；上线前验证"侧聊一轮后主对话没多出卡片" |
| R5 | 主会话归档会让侧栏会话被 `ArchivedSessionGate` 连带挡住（lineage 沿 `origin:"subagent"` 上溯） | 主对话归档后侧聊突然不能跑 | 预期行为，产品文案写清；或客户端检测 `ctx.workspaces` 的归档集给出提示 |
| R6 | 侧 Agent 一直 live（直到 close/卸载），空闲也占内存；Actor 生命周期归 AgentRegistry，不归我们 fiber | 多个主对话各留一个空闲 Agent | 可改成"每个 turn 结束后 dispose，下次 send 前 resume"（等价 subagent manager 的 cold resume，草稿的 resume 路径已具备）；或加空闲计时器（当前故意没做） |
| R7 | 审批/提问类交互（approval、ask_user_question、plan review）在侧栏是否可达未实测 | 父会话审批策略为 `ask` 时侧聊工具可能卡住 | 侧会话复制父会话的 approval knob（草稿已做）；上线前实测一次需要审批的工具调用；必要时把侧栏 approval 固定为 `never` 并在 UI 说明 |
| R8 | 附件/图片不支持：`send` 只接受文本块 | 侧栏不能贴图 | v1 限制；要支持得走 `ctx.attachments.admitPromptContent` 等价逻辑 + manager 的 image admission（后者对我们不可用，需要自己实现） |
| R9 | 客户端"替换 composer"在 ui-slots 的 chain 选举规则未实测（`select` 返回 claim、`priority` 方向） | 侧栏可能同时出现两个输入框，或标准 composer 抢占 | 参照 ui-subagent 的 `selectReadOnlySubagent` + `priority:-10`（`ui-subagent/lib/client.js:944-952, 990-996`）写，实测确认优先级方向 |
| R10 | 模型选择器/预设徽标：侧会话没有 `model/selection`、`agent-preset/selected` 事件 | 侧栏顶部模型显示可能与父会话不一致（实际请求用的是父路由） | 可接受；要精确就在 setup 里 append `model/selection`（形状见 `dsh-api-session-controller/lib/index.js:312-315`） |
| R11 | HMR/重载：Host 半重载会 dispose 旧 Agent，客户端旧 tab 若仍指着旧 childId，`open({childId})` 会走 resume；两个实例短暂并存时 `rpc.handle` 的 prefix 路由会重复注册抛错 | 插件重载瞬间报错 | 正常重载是"先 dispose 再加载"；若观察到重复注册，改成 `try/catch` 后跳过并 warn |
| R12 | `session/follow` 对 subagent 地址要求 `projectionMode:"all"`（`index.js:1636`），而 `subagent` 投影由 `dsh-subagent` 插件注册（`dsh-subagent/lib/index.js:3009-3014`） | 若 profile 禁用 `dsh-subagent`，侧栏历史打不开 | 该 bundle 在 `dsh-base` 里是常驻行；若未来可禁用，需要自带一个同名投影（不推荐，会重复注册） |
| R13 | 没有"物理删除"，JSONL 永久留在 `~/.dsh/sessions` | 隐私/磁盘 | 产品文案写"结束即关闭，不会出现在任何列表"；真要清理只能 out-of-band（不建议插件做） |

---

## 7. 客户端契约（给 `client.js` 的实现要点，本次未改客户端）

1. **资源地址 + retain**（替换现有 fork 的 `sessions.fork`）：

   ```js
   // 打开：先问 Host 拿 childId（一个主对话一个）
   const opened = await ctx.connection.rpc.call('/side-chat', 'open', { parentSessionId, childId: previousChildId })
   const { childId } = opened.value

   // 资源 provider 内部：
   const address = { parentSessionId, childSessionId: childId, mode: 'continuable' }
   const reference = ctx.sessions.retain(address, { source: 'sideChat', signal })
   try {
     yield { ok: true, value: { address, reference } }
     await waitForAbort(signal)
   } finally {
     reference.release()
     void ctx.connection.rpc.call('/side-chat', 'close', { parentSessionId })
   }
   ```

   地址建议直接 encode 成 `dsh-resource://sidechat/session/<childId>?parent=<id>` 之类的自有协议（tab 类型也是自有的），不要复用 `subagentchat`（那是 ui-subagent 的 tab 类型，它自己的 composer/标题逻辑会介入）。

2. **transcript 渲染**照旧：`SessionProvider` + `renderFactorySlot('conversation.content', {variant:'embedded', …})`。主对话历史不会出现，因为会话 `isSeeded:false` 且我们只往里注入了一条隐藏 context。

3. **必须覆盖 composer**：在侧栏 slot 作用域注册 `conversation.composer` chain 条目，`select(owner)` 只对"我们创建的 childId 集合"返回 claim，组件自己做 `textarea + 发送/停止`，分别调 `send`/`cancel` RPC。**否则**标准 composer 会走 `subagents.prompt`（R4）。
   - 运行态可以从 `useSession(...).running` 读（`api-session/status` 事件对所有 Agent 广播，`api-session-controller/lib/client.js:4272-4277`）。
   - 用户消息落日志是在 Host claim 时（`agent-loop/lib/index.js:1063-1073`），所以发送后到出现气泡有极短延迟；要立刻回显可自行做乐观 UI。

4. **一个主对话只有一个侧栏对话**：客户端在打开前查 `ctx.sidebarRight` 里是否已有同 parent 的 tab（复用/聚焦），Host 侧 Map 兜底。

5. **刷新/重启恢复**：tab 记录（contentId 里的 childId）→ `open({parentSessionId, childId})`；返回 `resumed:true` 则继续，`side-chat/child-unavailable` 则丢弃旧地址、不带 childId 重新 open。

6. **不要**对侧栏会话调用：`ctx.sessions.fork/create/prompt`、`ctx.remote.session.*`（除 `follow/page` 由 retain 内部使用）、`ctx.workspaces.archiveSession`。不要渲染侧栏会话的 subagent 目录（我们没写 catalog，本来也没有）。

---

## 8. 验证清单（含未实测项）

> 本次为只读调研，**下面 3/4/6 未实测**（我没有安装/启用插件，也没有改 profile）。1/2/5 由代码与既有实测证据支撑。

1. 把 `side-chat/index.host-draft.js` 改名为 `index.js`（覆盖现在的空 `apply`），Host 进程需要重启或让 profile 重新加载（`dsh-hmr` 的 `root: []` 默认不监听插件源码，client-hmr 只热更 client bundle）。
2. 在浏览器里 `/side` → 期望：右侧栏出现空会话；左侧列表**没有**新行（包含 Ungrouped、搜索、归档筛选）；主对话里没有"subagent finished"卡片。
3. 侧栏发一句话 → 期望：正常出模型回复；刷新页面后 tab 恢复、历史还在（`resume`）。
4. 打开 DevTools 看 `/side-chat/open` 的响应与 `session/follow` 的 address（应为 `kind:"subagent"`、`mode:"continuable"`）。
5. 关闭 tab → 期望：Host `close` 后 `ctx.agents.get(childId) === undefined`；左侧列表仍然什么都没有；把该 childId 的 JSONL 留在磁盘（预期）。
6. 需要审批的工具（父会话 permission preset = workspace-write + ask）→ 观察审批卡片是否出现在侧栏（R7）。

---

## 9. 关键行号索引

> 基准：`<DSH_INSTALL>/node_modules/@deepseek-ai/`

**可见性**
- `dsh-client-ui-workspace/lib/client.js:964-974` `sessionVisible`（`origin==="subagent"` 永不显示；blank 仅当前可见；归档筛选）
- 同文件 `:1027-1046` `groupByWorkspace`（不在 workspace 的会话 → Ungrouped）
- 同文件 `:1185, 1200` 搜索结果同样过 `sessionVisible`

**catalog / 列表**
- `dsh-api-session-controller/lib/index.js:1959-2005` `ApiSessionList.list` / `summaryFor` / `summarizeCold`（live 全收；冷会话需 cwd）
- `:2127-2133` `listFields`（`parentSessionId/origin/cwd`）
- `:3061-3066` 远端 `session/list`
- `dsh-api-session-controller/lib/client.js:4160-4175` 客户端 ProjectList 行
- `:4196-4225` retained scope 生成 subagent 行

**保留 / 地址 / 历史**
- `dsh-api-session-controller/lib/client.js:3007-3036` `resolveTarget` + `subagentAddress`
- `:2606-2616` `configureSubagent`
- `:2923-2936` `sessionAddress`
- `:429-433` `session/follow({address})`
- `dsh-api-session-controller/lib/index.js:1631-1653` `sourceFor`（cwd 必需）
- `:1691-1711` `validateAddress`（descriptor / parent / mode）
- `:128-142` `hasApiSessionSubagentOwner` + 错误
- `:365-369` `liveAgent`（live 的 subagent 会话也返回 agent-busy）
- `:925-966` `prompt`（`resolveAgent` 路仍被上面挡）
- `:1061-1066` `cancel`

**创建 / 生命周期**
- `dsh-agent/lib/types/index.js:35-70` `AgentRegistry`；`:176-210` `create/resume`（`create` 返回 AgentHandle）
- `dsh-agent-loop/lib/index.js:1893-1910` `createAgent(ownerCtx, options)`；`:1780-1804` publish → `{agent, dispose}`；`:1791` `enter(agent, parentAgent)`
- `dsh-session/lib/index.js:1051-1053` header origin 校验；`:1823-1827` meta → header
- `dsh-session/lib/index.js:1194-1230` user/message 校验；`:1490-1520` `append` + surfaceOp
- `dsh-agent-loop/lib/index.js:806-814` `followup/steer/inject`；`:103-110` claim（next-step 全部）；`:1063-1073` step 内落 user/message；`:967-969` 空 turn 直接完成（不请求模型）
- `dsh-agent-preset-registry/lib/index.js:49-56` `agentPreset` 投影；`:686-716` `mount/composeFrom/composedPreset`

**descriptor / subagent**
- `dsh-subagent/lib/index.js:571-620` version 3 + 字段；`:626-664` `parseSubagentDescriptor`；`:670-684` `snapshotSubagentDescriptor`
- `:2731-2750` `subagent` 身份投影（descriptor → `{mode,label,seq}`）
- `:373-395` `applyChildComposition`（composeFrom/mount 的用法）；`:408-420` delegation 策略捕获（approval 钉 never，别照抄）
- `:2048-2056` `notifySettlement`；`:508-540` 结算消息；`dsh-subagent-spawn-in-process/lib/index.js:10-12, 36` provider 名 `spawn`

**隐藏上下文**
- `dsh-client-ui-chat/lib/client.js:8200-8202` `isVisibleChatNode`（context 行隐藏；权限 command 行隐藏）
- `:9832-9845` `contextMessage`；`:9853-9890` `messageDefinition`（非 user source → context）
- `dsh-client-ui-chat/README.md:51` "Hidden Chat rows"
- `dsh-llm/lib/index.js:41-63` `createMessage/createUserMessage` 形状
- `dsh-session/lib/index.js:217-230, 555-559` `deriveMessages`
- `dsh-client-ui-chat/lib/client.js:7024-7060` `turnTriggerDetails`（`subagent-settled` 卡片，R4 的证据）

**通道**
- `dsh-client-connection/lib/index.js:726-734` `get rpc()`；`:742-762` `admit`（Host/Origin + cookie/token）；`:855-883` `rpc.handle`；`:888-946` envelope；`:970-973` channel 规则
- `dsh-client-connection/lib/client.browser.js:1212-1240` `rpc.call`；`:1288-1313` response 校验
- `dsh-host-webserver/lib/index.js:323-336` 裸路由 `register`（无鉴权）
- `dsh-commands/README.md`（命令会 append `command/run|done`）
- `dsh-web-app/cordis.patch.yml:179-235` desktop/web profile 的 `webserver` + `connection` 行

**归档 / 删除**
- `dsh-api-session-controller/lib/types/archived-session-gate.js:17-25` 归档门；`:35-50` subagent lineage 上溯
- `dsh-session-persistence/README.md:153`、`dsh-session-persistence-jsonl/README.md:167`（无删除 API）
- `dsh-api-workspace-controller/lib/typert.remote-client.js`（`workspace/*` 无会话删除）

**其他**
- `dsh-user-approval/lib/index.js:63-65, 149-165` `approval/policy` 与 `effectivePolicy`
- `dsh-sandbox-policy/lib/index.js:41, 119` `sandbox/mode`
- `dsh-permission-presets/lib/index.js:87-95, 291-302` knob 投影与 `current()`
- `dsh-working-directory/lib/index.js:38-45, 72-78` 目录投影 / `get`
- `dsh-agent-default-model/lib/index.js:27` 服务名 `agentDefaultModel`
