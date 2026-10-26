# 右侧栏“一次性对话”（/side）调研：注册 tab、渲染会话、关闭销毁

调研范围：DSH 0.2.1-rc.3（`<DSH_INSTALL>/`）。
只读调研，未改插件代码、未安装、未改 profile。

---

## 0. 结论先行

1. **推荐路线 A：fork 出真实子会话 + 侧栏 tab 渲染 + 关闭时归档。**
   现成范本 = `@deepseek-ai/dsh-client-ui-subagent` 的 sidebar chat（资源协议 + builtin tab 类型 + `sidebar.right.pane.tab` body + 嵌套 session 作用域 slot + `SessionProvider` + `renderFactorySlot('conversation.content', …)`）。照抄这套结构，把“子智能体会话地址”换成“fork 子会话地址”即可，**客户端插件即可完成，不需要 Host 半体**。
2. **“关闭即销毁”只能做到“归档（archive）+ 释放所有客户端引用”，做不到物理删除。**
   Host 端没有任何 session 删除 RPC（`session/*` 端点清单里没有 delete/remove）；持久化层明确声明 `No deletion or retention API` / `Nothing deletes session files`。归档后：默认左侧列表不可见（`archivedFilter="default"`），可被“已归档筛选”重新显示并 unarchive，JSONL 日志仍在磁盘。**产品文案不要写“永久删除”。**
3. **关闭信号最可靠的钩子是“tab 记录消失 → 资源被 unpin → 我们的 resource provider 流被 abort → `finally` 里归档 + release”。**
   `registerCloseHandler(kind, handler)` 也存在且更“官方”（显式关闭/被替换时同步调用），但覆盖面比 resource-unpin 窄（插件卸载、布局清理不走它），建议只用 resource `finally` 做唯一清理点。
4. **收起右侧栏不会卸载 tab body**，也不会触发关闭；并且**没有公开的“右侧栏展开/收起”可订阅状态**。如果产品要求“收起侧栏也销毁”，只能在 body 里读 `useTabInfo().sidebar.expanded` 的响应式值再主动 `tab.actions.close()`（可行但是 UI 级 workaround，建议先不做，见 §6-B）。
5. **路线 B（不建会话、复用同一会话渲染）不成立**：`conversation.content` 的 occurrence 继承“渲染位置的 Session”，没有独立会话寻址能力（README 明说），同一会话的两个 occurrence 共享 input/conversation store（同一草稿、同一发送目标），只是镜像，不是 side chat。只适合做只读镜像视图。

关键不确定点（本次无法实测）：`ctx.sessions.retain()` 打开**已归档**会话历史是否被门禁拦截（代码上归档门只拦 `agent/pre-step`，按实现应可读，但未跑起来验证）；资源 provider 的 `finally` 里发起的异步 archive 在页面关闭/崩溃时是否必然完成（大概率丢失 → 残留未归档会话）。

---

## 1. 现成范本：ui-subagent 的 sidebar chat（逐字可抄）

文件：`node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js`

### 1.1 四段注册（`registerSidebarChat`，817–839 行）

```js
// 1) 资源协议：把地址变成一个"会话引用"，随 tab 记录的生命周期存活
ctx.effect(() => ctx.resources.register({
  protocol: "subagentchat",
  async *open(resourceAddress, { signal }) {
    const address = parseSubagentChatAddress(resourceAddress);       // 从地址解析 {parentSessionId, childSessionId, mode}
    if (isAbortRequested(signal)) return;
    const reference = sessions.retain(address, { source: "sidebarChat", signal });  // 762
    try {
      yield { ok: true, value: { address, reference } };             // 先给当前值
      await waitForAbort(signal);                                    // 一直挂着，直到 tab 记录消失/插件卸载
    } finally {
      reference.release();                                           // 776：引用释放（“销毁”的第一个动作）
    }
  }
}), "ui-subagent: Sidebar chat resources");

// 2) tab 类型（builtin；资源型：用 patterns 认领地址）
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: SUBAGENT_CHAT_ID,                                              // 819
  kind: "subagentchat",
  patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],                          // "dsh-resource://subagentchat/**"
  priority: "builtin",
  canOpen: (address) => parseSubagentChatAddress(address) !== undefined,
  title: (address) => { /* 打开时捕获的 chip 文案 */ }
}), "ui-subagent: Sidebar chat type");

// 3) tab body：声明一个属于自己的 session 作用域子 slot
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
  name: "sidebar.right.pane.tab",
  key: SUBAGENT_CHAT_ID,                                             // 830–837
  children: { "sidebar.chat.conversation": { kind: "single", scope: "session" } }
}, SidebarChatTab)), "ui-subagent: Sidebar chat body");

// 4) 子 slot 的占用者：真正的 Conversation
ctx.effect(() => ctx.slots.inject("sidebar.chat.conversation", () => ctx.slots.register(
  { name: "sidebar.chat.conversation" }, ConversationSlotPanel
)), "ui-subagent: Sidebar Conversation");
```

打开（969–972 行）：

```js
ctx.sidebarRight.openResource(subagentChatAddress(address), {
  kind: "subagentchat",
  preferNewPane: true
});
```

### 1.2 三个关键组件

`SidebarChatTab`（800–811 行）——tab body 的骨架：

```js
function SidebarChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo();
  const resource = useResource(tab.contentId);        // contentId 就是 dsh-resource:// 全地址
  return resource.value === undefined ? null : (
    <div data-sidebar-chat>
      <SessionProvider session={resource.value.reference}>   {/* 把会话绑定切到子会话 */}
        {renderSlot("sidebar.chat.conversation", {})}
      </SessionProvider>
    </div>
  );
}
```

> `useResource` / `SessionProvider` / `renderSlot` 都是 slot 框架注入的“标准 props”：
> - `useResource` 来自 `ctx.slots.provideRoot`（resources README:31、36）；
> - `SessionProvider` 只在 body **声明了 session / session-maybe 作用域子 slot** 时出现（`PropsRenderSlots` 声明：client-runner `lib/client.js:2066`）；会话绑定可以继承外层，也可以显式绑一个 `SessionReference`（ui-session README:11）。

`ConversationSlotPanel`（混装了 ui-subagent 的“嵌入形态”约定，782–798 行）：

```js
function FixedChatConversationView(props) {
  return <>{props.renderSlot("conversation.session", { view: "chat" })}</>;
}

function ConversationSlotPanel({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession((v) => v);
  const shellPhase = useConversation((v) => v).activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running
    ? "active" : session.promptAttempted ? "engaging" : "blank";
  const summaryBlank = useSessions((s) => s.byId[sessionId]?.blank);
  const parentAvailabilityPending = session.subagent?.address.mode === "continuable" && session.subagent.parentAvailable === undefined;
  const settling = shellPhase === "blank" && session.openState === "loading" && summaryBlank !== true || parentAvailabilityPending;
  const hero = shellPhase === "blank" && (session.openState === "open" || summaryBlank === true);
  return renderFactorySlot("conversation.content",
    { variant: "embedded", phase: settling ? "settling" : hero ? "hero" : "active", hero },
    { slots: { views: FixedChatConversationView } });
}
```

这对应 `conversation.content` 这个 **Component Factory**（`@deepseek-ai/dsh-client-ui-conversation`）：
- 工厂注册：`lib/client.js:19921–19983`，`scope: "session-maybe"`，children 含 `conversation.session`(single/session)、`conversation.composer`(chain/session)、`conversation.input.dock`(list) 等；本地 slots `views: {scope:'session'}`、`widthControls: {scope:'root'}`（19959–19962）。
- 实现：`ConversationContent`（17808–17812）里 `props.variant === "embedded"`（17931）、`phase`/`hero` 决定骨架态；`useFactorySlot("views", ConversationSessionView)` 取本地 views 覆盖。
- 官方限制（README:184）：**`conversation.content` 不接受“独立寻址的 Session”**，要渲染另一个会话必须靠 `SessionProvider` + 一个 session 作用域 slot —— 这正是上面 1.1(3)(4) 的写法。

---

## 2. 目标项目的精确 API 清单

### 2.1 tab 类型注册（`ctx.sidebarRightTabs.register`）

声明见 README:83 与 bundle 里的 `SidebarRightTabRegistry.register`（`ui-sidebar-right/lib/client.js:4580–4611`）：

```ts
ctx.sidebarRightTabs.register({
  id: string,                 // 唯一，跨所有注册；也是 body/title 的 key（建议包名）
  kind: string,               // 类型判别符；每个 kind 最多 1 个 builtin + 1 个 extension
  patterns?: string[],        // 资源型才需要：dsh-resource:// 地址的 glob（含 ':' 匹配整串，否则匹配路径）
  priority?: 'extension' | 'builtin' | 'fallback',   // 默认 extension
  canOpen?(address: string): boolean,
  title(address?: string): string,                   // chip 文案，打开时捕获（活标题另注册 title slot）
  guide?: { id, order, title(), description?(), icon? }[],
  keepMounted?: boolean,      // 默认 false；true 时跨 tab/Session 切换/收起/停靠保留 body
  multiple?: boolean,         // 资源型不需要；页面型为 true 时每次打开生成独立 contentId
}): () => void
```

要点：
- `priority: "builtin"`（我们要的就是内置行为）；`id` 与 body 的 slot `key` 必须相同。
- 资源型 tab 的 `tab.contentId` 就是打开时的**完整地址**（`claim()` 返回 `{kind, contentId: address, title}`，4702–4720）。
- 地址不匹配任何类型 / kind 未注册时 `openResource` / `openTab` **抛错**（设计上是接线错误，不是用户错误，README:93）。

### 2.2 打开 / 关闭 / 查询（`ctx.sidebarRight`）

`SidebarRightController`（`lib/client.js:2178–…`）：

```ts
openResource(address: string, options?: {
  kind?: string,           // 指定类型（跳过 glob，仍走 canOpen）
  params?: object,         // 进 body 的 navigation.params（revision 递增）
  paneId?: string,
  replaceTab?: string,
  preferNewPane?: boolean, // 先尝试分栏
  revealIfOpened?: boolean // 同地址 tab 已存在时是否聚焦
}): void
openTab(kind: string, options?): void
close(tabId: string): void
active(): TabRecord | undefined
isExpanded(): boolean
toggleExpanded(): void
tabsIn(sessionId): TabRecord[]
openTabs: ObservableSnapshot<{sessionId, tabId, kind, contentId}[]>   // 所有已开 tab 的元数据（含后台 Session）
mounted: ObservableSnapshot<SessionId | undefined>                    // 当前“屏上”会话
tabDomain: TabDomain                                                  // 内部面，公开文档称 adopt 不对外
```

- `openResource/openTab` 都要求**当前有屏上会话**，否则 `require()` 抛错（README:97）；打开会自动展开右侧栏（README:93）。
- 发起位置推荐用会话上下文里的 action（比如 `/` 命令的 client 半体），天然有屏上会话。

### 2.3 “某个 tab 被关闭”的两个信号

**(a) `ctx.sidebarRight.registerCloseHandler(kind, handler)`** — README:108，实现 `lib/client.js:2188–2200`：

```ts
registerCloseHandler(kind: string, handler: (sessionId: SessionId, tab: TabRecord) => void): () => void
// TabRecord = { id: string, kind: string, contentId: string, title: string }   (zod schema: lib/client.js:788–793)
```

- 仅两类路径调用：显式关闭（`closeIn` → `removeAfterCleanup`，2288–2291）与被 `replaceTab` 顶掉（`place()` 2338）。调用**同步**、在布局提交之前，注释要求 handler “先保留后台清理再放行”。
- **不**在收起侧栏、切会话、插件卸载时调用。handler 抛错会保留 tab。
- 无法拿到“用户是不是只切了 tab”——不会触发。

**(b) tab 记录消失 → occurrence signal abort → `ctx.resources.pin` 自动解除（推荐）**

`TabDomain.sync`（1913–1932 行）：

```js
for (const [tabId, occurrence] of held) {
  if (layout.tabs[tabId] !== undefined) continue;
  held.delete(tabId);
  occurrence.controller.abort();          // 记录消失 → abort occurrence
}
for (const tab of Object.values(layout.tabs)) {
  ...
  occurrence.pinned = true;
  this.pin(occurrence.navigation.getSnapshot().address, occurrence.signal);   // 1930：按记录生命周期 pin 地址
}
```

`pin` 注入自 `createSidebarRightController(tabs, (address, signal) => ctx.resources.pin(address, signal), …)`（4940–4941）。
resources README:66 明说：“The right Sidebar pins every open tab's address for the tab record's lifetime”。
→ tab 记录一旦消失（关 tab / 被替换 / undo 移除 / 插件卸载 / 清布局），pin 的 signal abort → 我们的 provider 流被 abort → `finally` 里执行归档 + `reference.release()`。
这个信号覆盖比 (a) 全（含插件卸载），**建议作为唯一清理点**；不需要同时注册 (a)，避免双触发。

### 2.4 tab body 的 `useTabInfo()`

`tabInfoFactory`（4856–4893）：

```ts
useTabInfo(): {
  sidebar: { expanded: boolean, fullscreen: boolean },
  panel: { id: string },
  tab: {
    id, kind, contentId, title,
    visible: boolean,          // 背景 Session / 非活动 tab / 收起的 dock 为 false
    navigation: { getSnapshot(): { address, params, revision } },  // 打开方传的 params
    signal: AbortSignal,       // occurrence 生命周期
    actions: {
      bindCommands(commands): () => void,
      openResource(address, options?): void,
      openTab(kind, options?): void,
      close(): void,           // 关闭自己
    },
    refreshShortcut,
  }
}
```

`tab.actions.close()` → `navigator.closeIn(sessionId, tabId)` → 走 closeHandler + 布局删除（1981–2026）。

### 2.5 收起侧栏是否卸载 body

- 不卸载。`ui-sidebar-right/lib/client.js:1287`（源码注释）：“**Docked content stays mounted while collapsed**, translated off the frame's right edge”；对应 CSS 用 `transform: translateX(...)` + `visibility` 隐藏 docked pane（同上，`SidebarRight.module.css` 片段）。面板节点也一直渲染（`SidebarPanel` 1518–1563，只改 `data-sidebar-right-open` / `aria-hidden`）。
- `keepMounted: true` 影响的是“跨 tab 切换 / Session 切换 / 停靠状态变化时保留已访问 body”（README:106、`TabSlot` 1368–1377 + `DockLayout keepMounted` 1547）；非活动 tab 的 body 默认会卸载，但这**不等于关闭**。
- 右侧栏展开/收起**没有公开的可订阅状态**：`ctx.layout` 公共面只有 `selectPanel / beginNavigation / toggleSidebar / openRightbar / closeRightbar / panelInfo`（`ui-layout/lib/client.js:452–495`），`rightbarShown` 在内部 store 的 `layoutInfo` 里，不在公共面。
- 唯一可行的响应式读法是在 body 内用 `useTabInfo().sidebar.expanded`（来自该会话的 sidebar store，会随收起重渲染）。要“收起即销毁”，就在 body 里 `useEffect(() => { if (!sidebar.expanded) tab.actions.close(); })`。

---

## 3. 会话生命周期（fork / 归档 / 删除）

### 3.1 客户端 fork 签名

`@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js:339–359`：

```ts
await ctx.sessions.fork({
  sessionId: string,              // 源会话（必填）
  atSeq?: number,                 // 精确的 inclusive 事件边界；省略 = 最近一个“已完成轮次”前缀
  allowMigration?: boolean,       // 默认 true；false 时源会话非 live 且旧格式会拒绝
  increaseTitle?: boolean,        // true 时把源标题递增成 "xxx (1)"
  onCreated?: (childId: string) => void,
}): Promise<string /* childId */>
```

- 只调 `remote.session.fork`，成功后 `projectList()`；**不**改变主视图（需要自己 `ctx.uiWorkspace.openSession(id)` 或我们的 `openResource`）。
- 失败抛 `SessionForkError`（含 `rpcError`、`sourceSessionId`）。可识别错误码：`session/fork-unavailable`（源没有已完成轮次 / `atSeq` 不存在）、`session/not-found`、`session/migration-required`、`gateway/internal`、`session/workspace-attach-failed`（子会话已创建但挂 workspace 失败，`rpcError.details.sessionId` 是真实 child id，可救）。
- **不需要源会话“已打开”**：Host 端 `commands.fork` 通过 `ctx.sessionQuery.observeSession()` 直接读持久化日志（`lib/types/commands.js:216–294`）；`forkRequiresOpen` 那个 toast 只针对 `allowMigration:false` + 非 live + 旧格式（`lib/types/index.js:486–495`）。我们是从当前打开会话触发，源一定 live，所以**不会**撞上 migration 限制（且 `ctx.sessions.get(sourceId)` 非空，preflight 直接跳过）。
- fork 结果**已持久化**：Host 用 `agents.create({sessionId: childId, seed, inheritedEventCount, meta:{parentSession, isSeeded:true, cwd}})` 建真实会话日志（commands.js:254–285），并 `workspace.attachSession(childId)`（277–283）。
- fork 出来的子会话是**普通会话**（header origin 只能是 `"subagent"` 或 undefined；fork 不设 origin）→ 会作为普通行出现在左侧列表（可能先短暂按 blank 占位，`manager.fork` 495–499 里有 `blank: true` 的临时 summary）。

### 3.2 Host 有没有删除会话接口？——没有

- `session/*` 远程端点全集（`api-session-controller/lib/typert.remote-client.js`）：
  `attachment, canOpenWorkspacePath, cancel, control, create, follow, fork, initializeDefaultModel, list, modelCatalog, openWorkspacePath, page, projections, prompt, rename, search, selectModel, updateQueue, workspacePathApplications` —— **无 delete/remove/trash**。
- `workspace/*` 端点全集：`archiveSession, create, delete, follow, initializeDefault, insertBefore, insertSessionBefore, pinSession, rename, unarchiveSession, unpinSession` —— `workspace/delete` 删的是 workspace 注册（文档明说“removing a project never deletes its folder or sessions”）。
- 持久化层显式声明（`dsh-session-persistence/README.md:152`）：**“No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.”**
- JSONL 后端（`dsh-session-persistence-jsonl/README.md:166`）：**“Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API.”**
- `dsh-session-query-sqlite/lib/index.js:760–768` 里的 `_deleteSession` 只是**索引行**清理（当持久化观察发现文件没了时自愈），不是删除 API。

### 3.3 archive 的语义（能做到哪一层）

客户端服务：`ctx.workspaces`（`api-workspace-controller/lib/types/client/service.js:28–39, 68–72`）

```ts
class WorkspaceController extends Service {   // 服务名 'workspaces'
  async archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  async unarchiveSession(sessionId: string): Promise<void>
  // 失败抛 WorkspaceArchiveError（rpcError.code 区分）
}
```

- 不传 `stopActivity` 且会话有运行中工作（turn/subagent/job/schedule）→ 拒绝，`workspace/session-active`，details 列出在做的工作；传 `stopActivity: true` 会先停工作在后台收尾（README:25、`dsh-workspace/README.md:102`）。
- 归档要求会话“live 或 persisted”；归档同时清掉 pin（`dsh-workspace/README.md:100, 170`）。
- **左侧列表可见性**（`ui-workspace/lib/client.js:958–974`）：

```js
function sessionVisible(session, current, archived, archivedFilter) {
  if (session.origin === "subagent") return false;      // subagent 子会话永远不进普通列表
  if (session.blank && session.id !== current) return false;   // blank 会话只有当前那个可见
  switch (archivedFilter) {
    case "default": return !archived.has(session.id);   // 归档 → 默认隐藏
    case "show": return true;
    case "only": return archived.has(session.id);
  }
}
```

  `archivedFilter` 默认 `"default"`，UI 有“筛选已归档会话”（locale `toast.archivedFilter`）。→ 归档后默认从左侧列表消失，但用户可切筛选看到并 unarchive。
- **归档会挡住继续对话**：`ArchivedSessionGate`（`api-session-controller/lib/types/archived-session-gate.js:17–25`）监听 `agent/pre-step`，被归档会话（及其 subagent 后代）的模型步骤直接被 reject。所以**不能“一开就归档再聊”**，只能“关掉时归档”。fork 出来的子会话是独立会话（注释：“a fork of an archived Session is an independent conversation”）。
- 归档后历史仍可读（门只在 Host 的 `agent/pre-step`）；**本次未实测** `sessions.retain()` 打开归档会话的返回（按实现应可读，因为 `retain` 走 `session/follow` 历史通道）。

### 3.4 “销毁”能达到的真实语义（供产品对齐）

| 层面 | 关闭 tab 时能做到 | 做不到 |
| --- | --- | --- |
| 客户端运行时 | `SessionReference.release()`，取消 retain、断历史流、卸载 View；从当前窗口侧栏布局中移除 tab 记录（localStorage 里该 tab 也一并清掉） | 保证浏览器崩溃/直接关窗口时执行到清理 |
| 导航 | `workspaces.archiveSession(childId,{stopActivity:true})` → 从左侧默认列表消失，pin 清除，不能再模型跑步 | 从 `session/list` / catalog / 搜索索引中彻底消失 |
| 磁盘 | 无 | JSONL 日志、投影缓存、全文索引仍在；无删除 API（要删只能 out-of-band 删文件，且会与 writer lock/索引/cursor 语义打架，不建议） |
| 恢复 | 用户可在“已归档”筛选里 unarchive 后继续用 | 无法恢复成“从未存在” |

---

## 4. 推荐实现（路线 A）骨架

```js
// my-side-chat/client —— 纯客户端插件
export const inject = ['slots', 'resources', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'workspaces', 'locale']

const ID = 'my-side-chat'          // 建议用包名
const PROTOCOL = 'sidechat'
const NS = 'sideChat'
const addressOf = (childId) => `dsh-resource://${PROTOCOL}/session/${childId}`
const childOf = (address) => /^dsh-resource:\/\/sidechat\/session\/([^/?#]+)$/.exec(address)?.[1]

export function apply(ctx) {
  // (1) 资源协议：tab 记录存活的唯一代表 → 关闭时归档
  ctx.effect(() => ctx.resources.register({
    protocol: PROTOCOL,
    async *open(address, { signal }) {
      const childId = childOf(address)
      const reference = ctx.sessions.retain(childId, { source: 'sideChat', signal })
      try {
        yield { ok: true, value: { address, reference } }
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      } finally {
        reference.release()
        void ctx.workspaces.archiveSession(childId, { stopActivity: true })
          .catch((error) => console.warn('[side-chat] archive failed', error))
      }
    },
  }), 'side-chat: resource')

  // (2) tab 类型
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: 'sidechat',
    patterns: [`dsh-resource://${PROTOCOL}/**`],
    priority: 'builtin',
    canOpen: (address) => childOf(address) !== undefined,
    title: () => t('title'),        // 固定文案最省事；要活标题再注册 pane.tab.title
  }), 'side-chat: type')

  // (3) body：声明自己的 session 作用域子 slot
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,
    locale: NS,
    children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } },
  }, SideChatTab)), 'side-chat: body')

  // (4) 子 slot 占用者：Conversation
  ctx.effect(() => ctx.slots.inject('sidechat.conversation', () => ctx.slots.register({
    name: 'sidechat.conversation', locale: NS,
  }, SideChatConversation)), 'side-chat: conversation')
}

function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo()
  const resource = useResource(tab.contentId)
  return resource.value === undefined ? null
    : <SessionProvider session={resource.value.reference}>{renderSlot('sidechat.conversation', {})}</SessionProvider>
}

function SideChatConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  // 照抄 ui-subagent 782–798 的 phase/hero 推导（嵌入形态、固定 Chat 视图）
  return renderFactorySlot('conversation.content',
    { variant: 'embedded', phase, hero },
    { slots: { views: (props) => props.renderSlot('conversation.session', { view: 'chat' }) } })
}

// 打开入口：`/` 命令的 client 动作里
async function openSideChat(ctx) {
  const parentSessionId = ctx.sidebarRight.mounted.getSnapshot()      // 或命令上下文自带 sessionId
  const childId = await ctx.sessions.fork({ sessionId: parentSessionId, allowMigration: true, increaseTitle: false })
  ctx.sidebarRight.openResource(addressOf(childId), { kind: 'sidechat', preferNewPane: true })
}
```

要点/注意：
- **不要**在 `SideChatTab` 的 unmount 里做事：body 卸载 ≠ tab 关闭（切 tab / 收起 / 背景 Session 都可能卸载）。
- `increaseTitle: false`：`true` 时 fork 成功后会走一次 rename，rename 失败会让 `fork()` 抛错（此时子会话已经建好，变成“孤儿”）——见 service.js:353–357。
- fork 失败处理：`session/fork-unavailable` = 当前会话还没有已完成轮次 → 给用户提示（或降级为 `sessions.create` 空会话，见 §5）；`session/workspace-attach-failed` 可从 `error.rpcError.details.sessionId` 拿到 child id 继续用（代价：不在 workspace 里，落 Ungrouped）。
- tab 的 `contentId` 会写进 `dsh.sidebar-right.v1.<sessionId>` 的 localStorage 布局。刷新页面后布局恢复 → pin 重新触发 → 我们的 provider 重新 `retain(childId)`，侧栏对话能原样回来（这是“临时”但可恢复的期望行为；如果不希望跨刷新存活，需要在启动时清掉/归档残留，见风险 R4）。
- 一个协议只能有一个 provider；地址里带 child id 即可天然支持多个 side chat tab（不同地址 → 不同 tab）。

---

## 5. 路线 B 评估（不建会话，复用同一会话渲染）

做法：tab body 不包 `SessionProvider`，直接声明一个 session 作用域子 slot，或直接用 `conversation.content` 渲染“侧栏所在会话”。

结论：**不满足产品目标，只适合“只读镜像”。**

原因：
1. `conversation.content` 的 occurrence **继承渲染位置的 Session**（ui-conversation README:184 明确：“does not accept an independently addressed Session; that requires a separate Session-provider capability”）。所以它渲染的就是侧栏所属会话（主会话）。
2. 同一会话的 input / conversation 状态是**按 sessionId 单例**的：`inputHub`（ui-conversation `lib/client.js:19880`）与 `ctx.uiSession.provide({hooks:['conversation','input'], props:['inputActions']})`（19897–19913）都按 binding 提供。两个 occurrence 会共用同一份 draft、同一份附件、同一个发送目标。侧栏里打的字会出现在主输入框；侧栏发送 = 主会话发送。
3. 两个 `conversation.content` 实例还会争同一批 factory 本地 slot / 滚动/宽度测量状态，容易出双编辑器、双滚动绑定的怪问题。
4. 唯一可“独立”的话就只剩 UI 外观上的两处：例如只把 `conversation.session`（transcript）渲染到侧栏、把 composer chain 替换成只读占位（`conversation.composer` 是 chain slot，ui-subagent 的只读 composer 走的就是 composer 选举）。但那是“同一个会话的第二视图”，没有 independent 上下文，也没有“关掉即销毁”的对象。

因此：若产品只要“在旁边看当前对话”，B 可用；若要“一次性 fork 子对话”，必须 A。

---

## 6. 备选会话来源（“不污染左侧列表”的其它可能）

先明确两个硬事实（`ui-workspace/lib/client.js:964–974`）：
- `origin === "subagent"` 的会话**永远**不出现在普通列表；
- `blank` 会话只有“当前会话”那一个可见，其它 blank 隐藏。

| 方案 | 列表可见性 | 能否作为 side chat | 代价/限制 |
| --- | --- | --- | --- |
| A. fork + 关闭时 archive（**推荐**） | 使用期间**会**出现一行普通会话（fork 不设 origin）；关闭后归档 → 默认隐藏 | ✅ 有父会话上下文、可独立对话 | 使用期间列表多一行；归档依赖浏览器还活着把异步请求发出去；磁盘留日志 |
| D1. `ctx.sessions.create({ workspaceId \| cwd, sessionId?, agentPreset? })` | 创建后是 blank → 初始隐藏；**第一次 turn/start 后就不 blank → 出现在列表** | ⚠️ 没有父会话上下文（除非把上下文塞进第一条 prompt） | 比 fork 便宜（不复制日志）；仍需归档；`create` 是客户端公开面（service.js:319–325） |
| D2. subagent 子会话（origin="subagent"） | ✅ 永远不进普通列表 | ✅（ui-subagent 已经实现了可续聊/只读两套 composer） | ❌ **客户端无法创建**：`subagents` 远程面只有 `subagents/prompt` 与 `subagents/interruptByParent`（`dsh-subagent/lib/typert.remote-client.js:66,132`），spawn 只在 Host 内部（工具/命令触发）。要做得加 Host 半体 + 自己的 RPC/工具 |
| D3. fork 后立刻 archive | 立即隐藏 | ❌ 被 `ArchivedSessionGate` 挡住模型步骤（archived-session-gate.js:17–25），发消息只会以 `blocked` 结束 | 不可行 |
| D4. 手删磁盘日志（绕过 API） | — | — | 破坏性：与 writer lock、投影缓存、SQLite 全文索引/cursor 语义冲突；持久化文档明确说这是 out-of-band 维护，不属插件职责。不建议 |

如果以后要“完全不进列表且可对话”，正确方向是 **D2：Host 半体提供一个“spawn 一个 continuable 子会话（origin=subagent）并返回 childId”的接口**，客户端继续用 ui-subagent 那套（甚至可以直接复用它的 `sidebar.chat.conversation` 渲染）；本次不做。

---

## 7. 风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | **物理删除不存在** | 文案/产品预期写“永久删除”会翻车 | 产品文案用“结束并归档”；说明磁盘留痕、可在已归档筛选里找回 |
| R2 | archive 是异步远程调用，写在资源 `finally` 里（不可 await） | 关窗口/崩溃/断网时归档可能没发出去 → 遗留未归档会话行 | 启动时做一次清扫：`ctx.sessions.list` 里找 title 带约定的前缀（如 `· 侧聊`）且 `ctx.sidebarRight.openTabs` 里没有对应 tab 的会话 → 补 archive；或接受少量残留 |
| R3 | fork 需要源会话有“已完成轮次” | 新会话/正在跑第一轮时 `/side` 直接失败 `session/fork-unavailable` | 捕获后提示；或降级 D1（空白会话）并把父会话上下文写进首条 prompt |
| R4 | tab 记录持久化在 localStorage（`dsh.sidebar-right.v1.<sessionId>`） | 刷新后侧栏 tab 会被恢复，临时会话跟着“复生”；用户以为已销毁 | 可接受（保持一致）；若要“刷新即销毁”，需要在启动时判断“本窗口从未打开过该 tab”——不可靠，建议不做 |
| R5 | 归档会 `stopActivity` | 关闭 tab 时正在跑的轮次会被中断（这正是“关掉就结束”的语义，但用户可能没预期） | 关闭前若有 running 给确认；或先 `cancel` 再 archive |
| R6 | 侧聊子会话与主会话“同名”（`increaseTitle:false` 时继承标题） | 列表里两行同名，用户分不清 | `increaseTitle:true` 则风险“rename 失败变孤儿”（service.js:353–357）；更稳的是开放前用 `ctx.sessions`/`uiWorkspace` 的 rename 能力改成 `xxx（侧聊）`，或在 tab title 上体现 |
| R7 | 用户可能把侧聊 tab 拖成浮动面板 / 分栏 / 切到别的会话 | 都要正常工作（地址与 Session 无关，pin 跟着记录） | 用 `preferNewPane: true` + 默认不 `replaceTab`；浮动面板同样支持 |
| R8 | 用户在左侧列表打开/重命名/删除（归档）侧聊会话 | 侧栏里可能变成“已归档会话”的只读视图 | 监听 `ctx.sessions.list` 的归档集合？客户端模型在 `ctx.workspaces`（`archivedSessionIds`）；可在 body 检测到归档后提示“已结束” |
| R9 | 收起侧栏不销毁、无公开 expanded 事件 | 若产品要求“收起即销毁” | body 内 `useTabInfo().sidebar.expanded` + `tab.actions.close()`；但会和“暂离一下”的直觉冲突，建议先不做 |

---

## 8. 待确认（本次未能实测）

1. `sessions.retain()` 对**已归档**会话的可读性（按代码应可读，归档门只拦 `agent/pre-step`）。
2. 资源 `finally` 中异步 archive 在 `beforeunload` / 进程被杀时的完成率（Node/浏览器语义上都可能丢）。
3. 客户端 inspect 服务（`cordis_inspect_query` client Service/Slots）在本会话连续 10s 超时，无法取运行时 `sidebarRight`/`sessions` 的**权威类型契约**；本报告的签名来自随包 README + 编译产物注释 + `@deepseek-ai/dsh-cordis-client-runner` 内置的 client API 目录（该目录给出了 slot 的 `standardProps`/`declaredBy`/`occupants` 与 `SessionReference`、`RenderFactorySlot` 等声明）。另外本 build **没有随包发 `.d.ts`**（`lib/types/**` 不在 asar 内，只有 README 里提到的路径），`package.json` 仍声明它们存在。
4. 一个会话最多能开几个 side chat tab、以及 `sidebar.right` 两格上限对我们的影响（`preferNewPane` 在没空间时会退化为当前 pane）。
5. 侧聊子会话是否应继承 workspace（fork 自动 `attachSession`）；若源会话无 workspace（cwd 直开），fork 走 `cwd` 分支，会落在 Ungrouped。

---

## 9. 关键文件与行号索引

> 基准目录：`<DSH_INSTALL>/node_modules/@deepseek-ai/`

**ui-sidebar-right**
- `dsh-client-ui-sidebar-right/README.md:83` 两段式注册与全部字段；`:84` body 注册与 useTabInfo；`:93` openResource/openTab/placement/params；`:97` close/active/isExpanded/toggleExpanded/split；`:104` Tab domain 生命周期与 signal；`:106` keepMounted；`:108` registerCloseHandler 语义；`:119` `multiple:true`。
- `lib/client.js:4580–4611` 类型注册实现；`:4702–4720` `claim`；`:2178–2200` controller + registerCloseHandler；`:2288–2291` removeAfterCleanup（close handler 调用点）；`:2293–2339` place/地址与 replaceTab；`:1913–1932` TabDomain.sync（abort + pin）；`:1981–2030` occurrence/tab.actions；`:4856–4893` tabInfoFactory（sidebar.expanded）；`:1368–1377` TabSlot keepMounted；`:1287–1299` 收起仍挂载；`:1518–1563` SidebarPanel 常驻渲染；`:788–793` tab record schema；`:5029–5077` rightbar / rightbar.session seat（含 `sidebar.right.pane.tab` children 声明）。

**ui-subagent（范本）**
- `dsh-client-ui-subagent/lib/client.js:755–780` resource provider（retain/release/waitForAbort）；`:782–798` ConversationSlotPanel + FixedChatConversationView + renderFactorySlot('conversation.content')；`:800–811` SidebarChatTab（useResource → SessionProvider → renderSlot）；`:817–839` 四段注册；`:961–973` openResource 打开方式。README:28–30 说明设计意图。

**ui-conversation**
- `README.md:86` main.conversation 壳与 conversation.content Factory；`:184` 工厂继承渲染位置 Session 的限制。
- `lib/client.js:19921–19983` conversation.content 工厂注册（children/slots/inject）；`:17808–17812` ConversationContent + useFactorySlot('views')；`:17931` `variant === 'embedded'`；`:17607–17620` 主视图的 phase/hero 推导；`:19880, 19897–19913` inputHub / uiSession.provide（输入与 conversation 按 session 单例）。

**api-session-controller**
- `lib/types/client/sessions/service.js:188–213` retain/using；`:94–138` ClientSessionReference（release/ready/binding）；`:319–325` create；`:339–359` fork 公开面。
- `lib/types/commands.js:216–294` Host fork 实现（observeSession、boundary、agents.create、attachSession）。
- `lib/types/index.js:486–495` `session/migration-required` preflight。
- `lib/types/archived-session-gate.js:17–25` 归档门（拦 agent/pre-step）。
- `lib/types/list.js:319–324` 列表行 origin/parentSessionId。
- `README.md:79` retain 的 target 与 ready/release；`:81` 普通会话 retain 不加 catalog 行。
- `lib/typert.remote-client.js` `session/*` 端点全集（无 delete）。

**workspace**
- `dsh-api-workspace-controller/lib/types/client/service.js:28–39` 服务名 `workspaces`；`:68–72` archiveSession。
- `dsh-api-workspace-controller/README.md:25` stopActivity 与 workspace/session-active。
- `dsh-api-workspace-controller/lib/types/client/model.js:128–140` 归档成功即本地 installArchived + 清 pin。
- `dsh-workspace/README.md:100` 归档清 pin；`:102` activity 检查；`:170–171` archive/unarchive 的检查差异。
- `dsh-client-ui-workspace/lib/client.js:964–974` sessionVisible（subagent 永不显示 / blank / archived filter）；`:1129–1136` visibleSessionIds；`:1419–1422` createInWorkspace 复用 blank；`:5140–5153` 侧栏 fork 入口（increaseTitle、allowMigration:false、forkRequiresOpen toast）。

**持久化**
- `dsh-session-persistence/README.md:152` 无删除/保留 API。
- `dsh-session-persistence-jsonl/README.md:166` 无人删 session 文件；`:76` 懒物化（create 不落盘）。

**资源 / slot 框架 / 布局**
- `dsh-client-resources/README.md:31,36` useResource 标准 hook 与返回 {status,value,failure}；`:41–61` provider 契约；`:66` “右侧栏为每个 open tab 的地址 pin 到记录生命周期”。
- `dsh-client-ui-session/README.md:11` SessionProvider 可继承外层或显式绑 SessionReference。
- `dsh-cordis-client-runner/lib/client.js:5662–5698` `sidebar.chat.conversation` 目录（kind single / scope session / standardProps / declaredBy=ui-subagent / occupants=ConversationSlotPanel）；`:5844–5895` `sidebar.right.pane.tab` 目录（standardProps 含 useChat/useConversation/useInput/inputActions/useSession/sessionId/useProjection/useTrajectory 等，declaredBy rightbar.session）；`:2061–2071` PropsRenderFactories/PropsRenderSlots（SessionProvider 何时存在）；`:2181–2206` SessionReference/SessionRetainOptions/SessionTarget 声明。
- `dsh-client-ui-layout/lib/client.js:452–495` ctx.layout 公共面（无 rightbar 展开态订阅）；`:394–444` layoutInfo（rightbarShown 等内部字段）。
