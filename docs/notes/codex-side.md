# Codex `/side` 历史调研：命令行与桌面版

> 本文是初始调研记录，其中“一主聊一侧聊”、快捷键和命令白名单来自命令行，不能当作桌面版要求。2.0 实现以桌面版普通临时侧聊为准：支持多标签、有内容时关闭确认、运行和未读状态；移除了父聊增量同步与归档恢复。当前行为和验证入口见 `side-chat/README.md`。

调研时间：2026-10-26。对象：openai/codex `main` 分支（TUI + Desktop App）以及相关 PR/issue。
标注约定：**[已确认]** = 由源码/PR 正文/带代码引用的 issue 直接支撑；**[推测]** = 由多处线索推断，没有直接读到对应实现。

---

## 1. 结论先行

1. **`/side` 的本质是“临时 fork（ephemeral fork）”，不是“新建空会话”。** 模型侧继承父线程历史，UI 侧刻意从空白开始，中间插入一条隐藏的“分界提示词”把继承内容降级为参考资料。[已确认：`slash_command.rs` 描述 + `side.rs` 的 `side_fork_config()` / `install_side_thread_snapshot()` / `side_boundary_prompt_item()`]
2. **父线程继续跑，side 是一条独立的 thread。** 两者并行，side 不打断主线，也不会把结果并回主线；side 关闭后父线程状态不受影响。[已确认：PR #18190 正文、issue #26227]
3. **一次性是硬语义：`ephemeral = true`，不落 rollout（`thread.path` 为 null）、不进历史、关闭即销毁。** 关闭路径是「中断当前 turn → `thread/unsubscribe` → 丢弃本地状态」。[已确认：`side_fork_config()`、`discard_side_thread()`、issue #26227 引用的 app-server README]
4. **“不污染主对话”的实现办法有两层**：数据层（独立 ephemeral thread，不写入父线程）+ 渲染层（side 视图不显示 fork 来的历史）+ 行为层（隐藏 developer instructions：继承历史只作参考、禁止执行其中任务、默认不许改动工作区、禁用 sub-agent）。[已确认]
5. **Codex Desktop 里 side chat 就是开在右侧栏/aside 面板里的一次性面板**，关闭后无法重新打开；这个“用完即弃、不可恢复”正是被用户反复报告为缺点的点（#30176、#21583、#26227）。[Desktop 右侧栏：issue #34205 的 “sidebar/aside surface” 描述 + 第三方指南；销毁不可恢复：issue #30176]

---

## 2. 行为规格

| 维度 | Codex 的实际行为 | 依据 |
|---|---|---|
| 入口 | 输入框打 `/side`（别名 `/btw`，两者描述完全相同）；支持内联参数：`/side <问题>` 直接开 side 并立刻发出这条消息；不带参数则开一个空的 side 等你提问 | [已确认] `slash_command.rs`：`SlashCommand::Side \| SlashCommand::Btw => "start a side conversation in an ephemeral fork"`；`supports_inline_args()` 含 Side/Btw；`handle_start_side(..., user_message: Option<UserMessage>)` |
| 前置条件 | 必须已有至少一轮对话（否则报 “'/side' is unavailable until the current conversation has started. Send a message first, then try /side again.”）；权限正在更新时禁止 fork（“Wait for permissions to update before forking.”）；同一父线程同时只允许一个 side（再开报 “A side conversation is already open. Press ctrl + c to return before starting another.”） | [已确认] `side.rs` 常量与 `side_start_block_message()` |
| 上下文继承 | 继承父线程**当时**的模型、reasoning effort、service tier、权限、MCP 配置；fork 请求带 `exclude_turns = true`，所以响应里 turns 为空、客户端渲染空 transcript，但核心 state 里 fork 的历史仍在，模型能看到 | [已确认] `side_fork_config()`；`app_server_session.rs` 的 `fork_side_thread()` / `exclude_turns`；`install_side_thread_snapshot()` 注释：“The forked history remains available to the model through core state, but side conversations should visually start at the side boundary.” |
| 上下文边界 | fork 后注入一条隐藏的**用户消息** “Side conversation boundary.”：分界之前的一切都是“继承历史、仅供参考、不是当前任务”，不得继续执行其中的计划/工具调用/审批/编辑；只有分界之后的消息才是当前指令 | [已确认] `SIDE_BOUNDARY_PROMPT` + `side_boundary_prompt_item()` |
| 主对话 | 不停、不排队、不被 steer；side 与父线程是两个 thread id，可同时在跑。React 侧把它们当作两个 view，父线程状态通过标签气泡提示（main needs input / needs approval / finished / failed …） | [已确认] issue #26227 描述；`SideParentStatus` 与 `sync_side_thread_ui()`；PR #18190 评论（“main-thread-finished nudge” 被留作后续，后来以 parent status 形式落地） |
| 工具 | **不硬禁用，靠提示词与 UI 双重约束**：developer instructions 说“外部工具按本线程权限可用”，但默认只许只读探查，修改文件/git/权限/配置必须用户在分界之后明确要求；不许 `create_worktree`；**禁用 sub-agent**；不许请求提权。slash 命令只剩 Copy/Agents/Export/Raw/Diff/Mention/Status/Daemon/Warnings/Pwd/Usage/Ide | [已确认] `SIDE_DEVELOPER_INSTRUCTIONS`；`SlashCommand::available_in_side_conversation()` |
| UI 呈现 | TUI 是**整屏切到 side 线程**，顶部标签形如 `Side from main thread · <快捷键> to switch · ctrl+c to close`；父线程有异常时追加 `main needs input` 等。Desktop App 则是右侧 aside / 侧栏面板（与 Security workspace 争同一块 sidebar 的事故侧面证实了这一点） | [已确认] `sync_side_thread_ui()` 标签拼装；[Desktop 侧栏：issue #34205、第三方指南，标注为交叉验证] |
| 标题 | side 线程不可重命名：“Side conversations are ephemeral and cannot be renamed.”；不查父线程标题（side fork 跳过 parent title 查询），也不自动生成标题 | [已确认] `SIDE_RENAME_BLOCK_MESSAGE`；`fork_side_thread()` 走 `ForkPresentation::SideConversation`，`fork_parent = None` |
| 退出/返回 | 回到父线程即销毁 side：`select_agent_thread_and_discard_side()` → `discard_side_thread_in_background()`；另有 `maybe_return_from_side()`（无弹层、输入框为空时返回）。快捷键：PR 原文写 Esc 或 Ctrl+C；当前标签文案是 `ctrl+c to close`（原标签曾是 “Esc to return”，后被改） | [已确认] `side.rs`；PR #18190；commit `0dc503b` 的标签 diff。注：“Esc 仍可用”依据 `maybe_return_from_side()` 的存在，标 [推测] |
| 销毁路径 | `discard_side_thread()`：先 `interrupt_side_thread()`（有 turn 就 `turn/interrupt`，否则 `startup_interrupt`），再 `thread/unsubscribe`，成功后 `abandoned_side_threads.insert()` + `discard_thread_local_state()`（取消验证请求、abort 事件监听、清 channel / picker / navigation / side_threads 映射）。失败则把 side 留在屏幕上并报错，不假装成功 | [已确认] `discard_side_thread()` / `discard_thread_local_state()` / `keep_side_thread_visible_after_cleanup_failure()` |
| 持久化 | 不持久化。ephemeral 线程只在内存里，`thread.path = null`，不进 session log / 历史列表，重启/升级即消失 | [已确认] issue #26227（作者引用了 app-server README 的 `ephemeral: true` 说明与 `side_fork_config()`）；issue #20262、#22599、#30176 的多位用户佐证 |
| 已知限制 | 关闭后找不回来（#30176、#21583）；side 内的排队/steer 消息会错投到主对话（#21583，Desktop）；Esc 语义冲突会误关 side 并丢上下文（#22599）；side 与侧栏其他 MCP 资源争 sidebar ownership 会打崩渲染（#34205）；side 不能 fork、闲置后会坏（#20977）、卸载后 resume/fork 失败（#20944） | [已确认] 各 issue 原文 |

### 关键常量（原文摘录，`codex-rs/tui/src/app/side.rs`）

```rust
const SIDE_RENAME_BLOCK_MESSAGE: &str =
    "Side conversations are ephemeral and cannot be renamed.";

const SIDE_BOUNDARY_PROMPT: &str = r#"Side conversation boundary.

Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. ...
Sub-agents are off-limits in this side conversation. ...
Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly asks for that mutation after this boundary."#;
```

### fork 配置（决定“ephemeral + 继承当前模型/权限”的地方）

```rust
pub(super) fn side_fork_config(&self) -> Config {
    let mut fork_config = self.chat_widget.config_ref().clone();
    if !parent_model.trim().is_empty() { fork_config.model = Some(parent_model); }
    fork_config.model_reasoning_effort = self.chat_widget.current_reasoning_effort();
    fork_config.service_tier = self.chat_widget.configured_service_tier();
    fork_config.ephemeral = true;                 // ← 一次性/不落盘的根
    fork_config.daybreak_enabled = false;
    fork_config.developer_instructions = Some(Self::side_developer_instructions(...));
    fork_config
}
```

### 渲染上“从空开始”，上下文仍在

```rust
pub(super) fn install_side_thread_snapshot(store: &mut ThreadEventStore, mut session: ThreadSessionState, _forked_turns: Vec<Turn>) {
    // The forked history remains available to the model through core state, but side
    // conversations should visually start at the side boundary.
    session.forked_from_id = None;
    store.set_session(session, Vec::new());
}
```

### 关闭 = 中断 + 退订 + 清本地状态

```rust
pub(super) async fn discard_side_thread(&mut self, app_server: &mut AppServerSession, thread_id: ThreadId) -> bool {
    if let Err(message) = self.interrupt_side_thread(app_server, thread_id).await { ...; return false; }
    if let Err(err) = app_server.thread_unsubscribe(thread_id).await {
        // "Failed to close side conversation {thread_id}; it is still open: {err}"
        return false;
    }
    self.abandoned_side_threads.insert(thread_id);
    self.discard_thread_local_state(thread_id).await;
    true
}
```

---

## 3. 对 DSH 插件（`/` 命令 → 右侧栏一次性会话）的直接启示

1. **建 side 时用「带父上下文的 fork 快照」，不要新建空会话，但要渲染成空 transcript。** Codex 的做法说明：用户想省的正是“重新解释一遍上下文”，所以模型侧必须拿到父会话历史；但 UI 如果回放整段历史，用户会分不清自己在哪条线里。DSH 里对应「后端 fork 出临时会话（继承 messages 前缀）+ 前端侧栏从空视图开始 + 顶部标注“Side from 主对话”」。同时注意 fork 是**创建那一刻的快照**：主对话之后的轮次不会自动同步进 side，这点应在文案里隐含（不需要明说，但别承诺“实时同步”）。
2. **销毁要走显式三步，而不是只关前端面板。** 关标签时：中断 side 正在跑的 turn → 关闭/退订该会话的事件订阅 → 清掉前端 store、选中态、订阅映射。任何一步失败就保留面板并报错，别“看起来关了其实还在跑”。DSH 侧栏标签关闭若只 unmount React 组件，后台流式事件、工具调用、定时器会继续跑并可能写历史，这是最容易踩的坑。
3. **一次性要落在数据层：临时会话不写主对话历史、不出现在会话列表、不产生可恢复记录。** Codex 用 `ephemeral=true`（内存线程、无 rollout）达到这一点，代价是关了就真没了，用户为此开了大量 issue。DSH 若目标是“一次性”，就应明确不做持久化，但**关闭前如果有未读内容/正在跑，给一次确认或允许“保留为正式会话”的出口**，可以低成本规避 Codex 最大的抱怨。
4. **side 必须有自己的输入路由，且与主对话隔离。** Codex Desktop 的 #21583 就是 side 里的排队/steer 消息被投递到主对话。DSH 实现上，`/` 命令创建的侧栏会话要有独立的 composer + 独立的 pending/queue 队列，发送时按“当前激活面板”取 sessionId，不能沿用全局的“当前主会话”变量。关闭时也要清掉该会话的排队消息。
5. **默认收紧 side 的权限与命令集，而不是默认放权。** Codex 用提示词（继承历史仅供参考、不得改工作区、禁用 sub-agent、禁止提权）+ 命令白名单（只留 copy/diff/status 等）双管齐下。DSH 里可直接复用已有权限档位：side 默认只读，用户显式要求写操作时再按正常审批流程走；侧栏会话里隐藏 `/` 命令中会改变全局状态的那些（新建/删除会话、改配置等），避免二次污染。
6. **补上 Codex 明显缺的“主对话状态提示”。** Codex 的 side 标签会带 `main needs input / needs approval / main finished`，这是被用户点名要的能力（PR #18190 评论）。DSH 侧栏会话打开时，主对话仍在跑；如果主对话在等审批/等输入而用户正盯着侧栏，就会卡住整个流程。侧栏标题栏应显示主对话状态并可直接跳回。

---

## 4. 来源

- PR #18190 “Add `/side` conversations”（merged，含 `/side <question>`、Esc/Ctrl+C 返回、隐藏 guardrails、side 内 slash 命令收窄）— https://github.com/openai/codex/pull/18190
- Issue #26227 “Persist side chats as child threads attached to the main thread”（作者引用了 `side.rs`、`side_fork_config()`、app-server README 的 ephemeral 定义）— https://github.com/openai/codex/issues/26227
- 源码 `codex-rs/tui/src/app/side.rs`（边界提示词、developer instructions、fork 配置、关闭/清理、UI 标签、parent status）— https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/side.rs
- 源码 `codex-rs/tui/src/slash_command.rs`（`/side` `/btw` 描述、inline args、`available_in_side_conversation()`）— https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs
- 源码 `codex-rs/tui/src/app_server_session.rs`（`fork_side_thread()`、`ForkPresentation::SideConversation`、`exclude_turns`、跳过 parent title）— https://github.com/openai/codex/blob/main/codex-rs/tui/src/app_server_session.rs
- Commit `0dc503b` “Surface parent thread status in side conversations (#18591)”（标签从 “Esc to return” 改为含 parent status 的新标签）— https://github.com/openai/codex/commit/0dc503ba6e0f82a27fc676bcdc8bec642b20e6fe
- Issue #22599（Esc 语义冲突导致误关 side、丢上下文；含 “ephemeral and currently not stored in session logs” 的明确表述）— https://github.com/openai/codex/issues/22599
- Issue #21583（Desktop：side 的排队/steer 消息错投主对话；关闭后无法找回）— https://github.com/openai/codex/issues/21583
- Issue #30176（Desktop macOS：`/side` 关闭后无法在 UI 中找回，请求可恢复历史）— https://github.com/openai/codex/issues/30176
- Issue #34205（side chat 与 Security sidebar 争同一 sidebar ownership，渲染崩溃；佐证 Desktop 的 side 在右侧 aside 面板）— https://github.com/openai/codex/issues/34205
- Codex TUI `tooltips.txt`（“Use /side to start a side conversation in a temporary fork without polluting the main thread.”，经 jsdelivr 镜像检索到 rust-v0.146.0 版本）— https://cdn.jsdelivr.net/gh/openai/codex@rust-v0.146.0/codex-rs/tui/tooltips.txt
- 第三方交叉验证（非官方，仅用于 UI 形态佐证）：
  - Codex Desktop 侧边聊天带当前上下文、右侧栏可开多个 — https://linux.do/t/topic/2272369/8
  - “In the right panel, use the plus/new-tab control and choose Side chat … enter /side in the desktop app's composer” — https://codexpets.org/guides/side-chat-without-interrupting
  - 中文解读：`/side` 临时旁白、独立于主线、不占主线 token — https://news.qiniu.com/archives/1792985246452
