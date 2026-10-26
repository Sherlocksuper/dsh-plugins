# DSH 插件开发调研笔记

这些是开发 [side-chat](../side-chat/) 插件过程中，对 DeepSeek Harness 0.2.1-rc.3 的接口调研记录。内容是**面向实现的考证**（带源码行号、行为规格、取舍与风险），不是插件运行所需的代码，也不是官方 API 文档。

## 目录

| 文件 | 内容 |
|---|---|
| [codex-side.md](codex-side.md) | Codex `/side` 的行为规格：ephemeral fork、上下文继承、隐藏历史、关闭时中断与清理 |
| [sidebar-side-chat.md](sidebar-side-chat.md) | 右侧栏一次性对话的实现要点：tab 类型注册、tab body、资源协议、关闭销毁 |
| [command-api.md](command-api.md) | 斜杠命令扩展 API：`ctx.commandUi` 注册/装饰、action 与 popupSelect、菜单排序、本地化 |
| [bundle-format.md](bundle-format.md) | workspace 插件 bundle 格式：manifest、patch、`client.js` 的加载形式、依赖与构建 |
| [host-side-session.md](host-side-session.md) | Host 侧会话创建与隐藏：`origin=subagent`、合成 descriptor、隐藏上下文注入、私有 RPC 通道、风险清单 |

## 占位符

文中出现的路径已做脱敏/泛化：

- `<DSH_INSTALL>`：DSH 桌面版的安装目录，即 `app.asar` 内的 `dsh/`（本笔记的源码行号都相对于它）。
- `<DSH_APP>`：`app.asar` 所在的 `Resources/` 目录。
- `<SRC>`：把 `app.asar` 内的包导出到本机临时目录后的路径。
- `<workspace>`：本仓库的工作目录。

## 注意

- 笔记针对 **DSH 0.2.1-rc.3**。行号、内部服务名与行为都随版本变化，升级后需要重新核对。
- 涉及的都是未公开的内部接口（`ctx.sessions.create({ cwd })` 的未归属语义、`systemPrompt.context` 的 per-Agent 作用域、`subagent/descriptor`、`conversation.composer` 等），改动前请先读对应插件的“已知限制”。
- 笔记里提到的 `app.asar` 内的 `.d.ts` 在该桌面发行版中并未打包，签名来自编译产物与调用点，而非类型声明。
