# DSH 斜杠命令（`/` 菜单）扩展 API 调研

> 目标：注册一个 `/side` action 命令，输入 `/` 后在菜单里选中「侧边栏会话」，在右侧栏打开一个临时对话。
>
> 结论先行，全部签名来自**运行时真实代码**（已把 app.asar 里的 `lib/client.js` 导出到 `<SRC>` 后逐行核对）。
> 文中 `$ASAR = <DSH_APP>`，路径均相对 `$ASAR`。

## 0. 一句话结论

在客户端插件里 `ctx.commandUi.register({ name:'side', label:()=>t('label'), available:(session)=>…, ui:{ kind:'action', run:(session)=>… } })` 即可；
`run`/`available` 拿到的 `session` **只有 `{ sessionId }` 一个字段**（`ui-input-trigger` 的 projection），要拿完整 Session 必须用 `ctx.sessions.binding(session.sessionId)?.session`；
包级 `dsh.client.inject` 至少列 `@deepseek-ai/dsh-client-ui-commands`，模块级 `inject` 至少列 `['commandUi','locale','sessions','sidebarRight']`。

---

## 1. `ctx.commandUi` 注册 API（权威来源）

服务实现：`dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js` 的 `CommandUiRuntime`（`var CommandUiRuntime = class extends Service`，:1385）。
服务键名 `commandUi`（`super(ctx, "commandUi")`，:1405）。

### 1.1 公开方法只有四个

| 方法 | 签名 | 语义 | 源码 |
|---|---|---|---|
| `register` | `register(contribution) => () => void` | 注册**客户端自有命令**；重名抛错（`duplicate contribution for /x`） | :1451-1463 |
| `decorate` | `decorate(decoration) => () => void` | 给**已有 host 命令**挂「裸调用」弹出的 popup/action，保留该 host 行的目录行、参数声明与生命周期日志；重名（同 name）抛错 | :1470-1482 |
| `dismiss` | `dismiss(name) => void` | 关掉该命令当前打开的 popup/确认框，草稿不动 | :1488-1490 |
| `popupFor` | `popupFor(actx) => PopupSelectController` | overlay 内部用，要求 retained Session scope；插件一般不用 | :1500-1526 |

**没有公开的命令目录查询接口**（目录 `CommandDirectory` 是私有字段 `this.directory`，只有内部 `candidates/resolve` 使用）。要「列出已有命令」目前只能走 `ctx.remote.commands.list(sessionId)`（:1416 内部调用的就是这个 RPC）。

### 1.2 `register(contribution)` 的字段（逐条来自 `candidates()` :1532-1556）

```ts
interface CommandContribution {
  name: string                       // 必填，不带 '/'，即输入 /side 里的 side
  label?: () => string               // 可选，每次候选计算都重新调用（:1549）
  description?: () => string         // 可选，同上（:1550）
  icon?: React.ComponentType<{ size?: number }>  // 可选，组件本身，不是元素（:1551）
  available: (session: { sessionId: string }) => boolean  // 必填，同步，菜单每次合成都会调（:1545）
  ui: ActionUi | PopupSelectUi       // 必填
}
```

`decorate(decoration)` 只需 `{ name, available, ui }`——没有 `label/description/icon`，因为它挂在 host 命令行上（真实用法见 `ui-permission-presets/lib/client.js:811-823`）。

### 1.3 两种 `ui` 形态

**action（本项目要用）**

```ts
{ kind: 'action', run: (session: { sessionId: string }) => void }
```

执行点 `invoke()`：`dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:1678-1687`

```js
invoke(name, ui, session, segment) {
  if (ui.kind === "action") {
    this.consumeVia(session.sessionId, segment);  // 先吃掉 /side 这个 token
    ui.run(session);                              // 同步调用，返回值既不 await 也不 catch
    return;
  }
  …popupSelect…
}
```

要点：`run` 里抛异常不会被框架接住（会冒到 pick 的调用栈），自己用 `try/catch` 包好。

**popupSelect**

选项加载与选中（`:1081-1103`、`:1239-1250`）：

```ts
{
  kind: 'popupSelect',
  options: (session: { sessionId: string }, signal: AbortSignal) => Promise<PopupOption[]>, // :1103
  onSelect: (option: PopupOption, session: { sessionId: string }) => Promise<void> | void,  // :1250
  searchLabels?: () => { placeholder: string; empty: string; noResults: string },           // :1082
  searchMode?: 'substring' | 'fuzzy-label'                                                    // :1097，默认 substring
}
```

`PopupOption`（渲染用到 `id/label/badge/detail/active`，:1940-1971；分组 :978-990；二次确认 :1911、:2030-2048）：

```ts
{
  id: string                  // React key（:1971），必填
  label: string
  detail?: string
  badge?: string              // 上标角标，如 EXP
  active?: boolean            // 当前值，打勾并作为打开时的高亮行
  group?: { name: string; label: string }   // 同名同组，按首次出现排序
  confirmation?: {            // 风险确认页
    title: string; description: string; acknowledgeLabel: string;
    cancelLabel: string; confirmLabel: string
  }
}
```

`searchLabels()` 每次打开重新求值；`options` 的 `signal` 是本次打开的 `AbortController`。

### 1.4 注册生命周期

`register/decorate` 内部用 `this.ctx.effect(...)`（runtime 自己的 fiber），返回**幂等 disposer**；调用方必须把它交给自己的 `ctx.effect` 才能在插件卸载时注销。业界统一写法：

```js
ctx.effect(() => ctx.commandUi.register(spec), 'myplugin: /side action')
```

真实例子：`ui-conversation/lib/client.js:19884-19895`（`scope.effect(() => commands.register({...}))`）、`ui-permission-presets/lib/client.js:811-823`（`ctx.effect(() => command.decorate({...}))`）。

### 1.5 命令名 vs 显示名

- 命令行只认 `name`：`matchEnter` 里是 `this.live.contributions.get(typedName)`（:1635），**contributions 没有本地化别名**（host 命令才有 `/计划` 这类 via locale claim token）。
- 菜单显示：`item.label ?? item.name`；当 `label` 与 `name` 大小写不敏感地不同时，行尾再显示 `name` 作 alias（`ui-input-trigger/lib/client.js:1817-1820`）。所以中文 label `侧边栏会话` + name `side` 会显示成「侧边栏会话 side」。

---

## 2. 从输入 `/` 到 action 执行：完整链路

1. **trigger 源**：`ui-commands` 在 `inputTriggers` 上注册唯一一个 `/` 源
   `dsh-client-ui-commands/lib/client.js:1423-1434`：
   ```js
   inputTriggers.registerSource({
     trigger: "/", name: "command",
     candidates: (session, req) => this.candidates(session, req),
     onPick: (pick) => this.dispatch(pick),
     matchSpace, matchClaim, matchEnter, warm, …
   })
   ```
   注册接口本体：`dsh-client-ui-input-trigger/lib/client.js:1556 registerSource(src)`；重名（trigger+name）抛错。

2. **候选**：`candidates(session, { query, quoted, position, signal })`（`ui-input-trigger` 侧 `:1420`）。
   `position` 是 `'leading' | 'inline'`；带 `hint`（host 命令有参数声明）的行只在 leading 时出现（`ui-commands:1554`）。
   本项目 `/side` 没有 hint，所以 leading/inline 都能出现——但 action 只在**裸 token** 下才执行（见 3）。

3. **菜单渲染**：`MenuView` 在 `conversation.input.overlay`（list、session scope）里渲染，`ui-input-trigger/lib/client.js:1693` 起；行内容 = icon + `label??name` + alias + description（:1806-1822）。icon 规则：字符串 → `ReferenceIconRegular kind=…`；否则当组件 `createElement(item.icon,{size:14})`（:1809-1812）——**必须传组件，不能传 JSX 元素**。

4. **选中**（鼠标/回车）：`settle()` 把 `{ candidate, session: this.project(), position, via:'menu', action, span }` 交给源的 `onPick`（`ui-input-trigger:1460-1462`）→ `ui-commands.dispatch()`（:1558-1585）。

5. **决策表**（`dispatch`/`matchEnter`）：
   - 有 `contribution` 且 `available(session)` → `invoke` → action 直接跑 / popup 打开；
   - 否则查 host 目录：`desc.input != null` → leadingInput claim（把 `/name ` 留在草稿里等参数）；否则 detached execute（发 `command.execute` RPC）。
   - **action 只在裸调用执行**：`matchEnter` 里 `if (!bare) return undefined`（:1637），即 `/side foo` 不会触发 action；
   - action 不受附件限制（:1638 对 popup/execute 才拒绝 `attachmentsUnsupported`）；
   - 执行后**不提交任何消息**，命令 token 被消耗，`command/executed` 只在本地 emit（:1732-1747），不进 session log。

6. **菜单排序的坑**：行顺序由 `SECTION_ROWS` 写死：Add = `file, goal, plan, feedback`，Commands = `compact, permission, model, export`；**未列出的行（含所有 contribution）追加在 Commands 末尾，按目录顺序**（:1290-1303、:1345-1361）。contribution **没有 `order` 字段**，想靠 order 排到前面做不到。

---

## 3. `run(session)` / `available(session)` 里的 session 到底是什么

这是最容易踩的坑。`ui-input-trigger` 给源的 session 是**投影对象**：

```js
// dsh-client-ui-input-trigger/lib/client.js:1359-1361
/** The session projection handed to sources (agent-backed identity; constant per scope). */
project() { return { sessionId: this.deps.sessionId }; }
```

即 `{ sessionId: string }`，**没有** `projections`、`command()`、`getSnapshot()`。`ui-commands` 原样把它传给 `available(session)`、`ui.options(session,…)`、`ui.onSelect(option,session)`、`ui.run(session)`（:1545、:1561-1566、:1684-1686）。

要拿完整 Session，用标准写法（`ui-permission-presets/lib/client.js:732-734、765`）：

```js
const sessionFor = (s) => ctx.sessions.binding(s.sessionId)?.session   // bindings 未建立时为 undefined
// 完整 Session 上可用：session.sessionId / session.projections.faceOf('x') / session.command('/xxx') / session.getSnapshot()
```

`ctx.sessions` 的来源与关键方法（`dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js`，`ClientSessions` :3790，`rootCtx.reflect.provide("sessions", this, undefined)` :3878）：

| 方法 | 源码 | 用途 |
|---|---|---|
| `binding(id)` | :4056 | `{ session, ctx, … } | undefined`，拿完整 Session / session-scope ctx |
| `sessionOf(actx)` | :4045 | 从 session-scope ctx 反查 Session |
| `scope(id)` | :4013 | sessionId → session-scope ctx |
| `retain(target,{source,signal})` / `using(target,opts,fn)` | :3842 / :3856 | 显式保留 / 借用（打开历史用） |
| `create({ cwd?, workspaceId?, sessionId?, agentPreset? })` | :3966-3978 | 建新会话，返回 `sessionId`（`remote.session.create` 的包装） |
| `list` | :3799 | 快照 store：`ids/byId/phase` |

`Session.command(line)`（:2473）等价于"以该 session 身份执行一条斜杠命令行"，返回 `{ ok, value:{ matched } }`；例如 `/permission` 的 picker 就是 `live.command('/permission auto')`（`ui-permission-presets:766-773`）。

action 里如需 `ctx`，注意 `run` 的回调没有传 ctx —— 用闭包捕获 `apply(ctx)` 的 `ctx`，或用 `ctx.sessions.scope(sessionId)` 取 session-scope ctx。

---

## 4. 真实 action 范例：composer 的 `/file`

`dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:19882-19896`：

```js
ctx.inject(["commandUi"], (scope) => {
  const commands = scope.get("commandUi");
  scope.effect(() => commands.register({
    name: "file",
    label: () => t("input.file"),
    icon: _deepseek_ai_dsh_client_ui_primitives.IconPaperclipOutlineRegular,
    available: (session) => inputHub.canPickFiles(session.sessionId),
    ui: {
      kind: "action",
      run: (session) => { inputHub.pickFiles(session.sessionId); },
    },
  }), "ui-conversation: File action");
});
```

值得照抄的三点：
1. `ctx.inject([...], scope => …)` 用于**可选**服务（服务缺失时这段不执行，插件其余部分照常）；`commandUi` 用必需 inject 也行（见 §6）。
2. `label: () => t("input.file")` —— 函数形式才能跟随语言切换。
3. `available` 只做同步判断（这里查 `inputHub` 的文件选择器能力），不做 async 查询。

popupSelect 范例（`ui-permission-presets/lib/client.js:811-823`，装饰 host `/permission`）：

```js
ctx.effect(() => command.decorate({
  name: "permission",
  available: (session) => selectionOf(sessionFor(session)) !== undefined,
  ui: {
    kind: "popupSelect",
    options: async (session) => {
      const selection = selectionOf(sessionFor(session));
      if (selection === undefined) throw new Error("permission presets are not available on this host");
      return optionsOf(await catalog.load(), selection.currentValue, t);
    },
    onSelect: (option, session) => submit(session.sessionId, option.id).then(() => void 0),
  },
}), "ui-permission: /permission decoration");
```

---

## 5. 本地化：`ctx.locale.register` / `bind` 的确切写法

服务实现 `dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`（`LocaleRuntime` :1187）。

```js
// 注册：register(ns, localeOrDicts, dict?) —— :1387
// 两种形态：
ctx.locale.register('local.side', { zh: {...}, en: {...} })   // 一次给全部 locale
ctx.locale.register('local.side', 'zh', {...})                // 单个 locale（语言包/增量）
// 返回 disposer；必须包在 ctx.effect 里
```

```js
// 绑定：bind(ns) —— :1414，返回稳定的 (key, params?) => string
const t = ctx.locale.bind('local.side');
t('label')                     // 查 'local.side'，再退回 'common'，最后显示 key 本身（:1422 translate）
t('count', { n: 3 })           // 模板插值 {n}（:1426 replace）
```

要点与坑：
- **必须同时给 `zh` 和 `en`**：运行时只校验 locale id 是否 BCP 47（:1389），但类型层（TS 内部包）要求两个内置 locale 齐备；外部 JS 插件不检查类型，但同一 namespace 注册两遍同 locale 会抛 `already has locale`（:1395）。
- namespace 名字自选（建议 `<plugin>.<area>`，避免撞 `common`/`settings.*`/`command`/`conversation` 等内置名）。
- **文案要在渲染/调用时取**：`label: () => t('label')`。如果写成 `label: t('label')` 直接传字符串，`ui-commands` 会调用 `contribution.label()` 直接崩（:1549 `contribution.label()`）；而且即使类型允许字符串，注册时取到的文案不会跟随语言切换（README 已注明 registry-held 文案只读一次：`dsh-client-locale/README.md:137`）。
- 中英示范：

```js
ctx.effect(() => ctx.locale.register('local.side', {
  zh: { label: '侧边栏会话', description: '在右侧栏打开一个临时对话', opened: '已在右侧栏打开临时对话' },
  en: { label: 'Sidebar session', description: 'Open a temporary conversation in the right sidebar', opened: 'Opened a temporary conversation in the sidebar' },
}), 'side: dictionaries');
const t = ctx.locale.bind('local.side');
```

- 其它相关 API：`ctx.locale.resolveText(text)`（:1241，解析 manifest 的 `LocalizedText`，普通字符串原样返回）、`ctx.locale.subscribe(fn)`（:1260，locale 变更）、`ctx.locale.setLocale(id)`（:1278）、`ctx.locale.addLanguage({id,label,fallback})`（:1297）。
- 手写 UI 的 slots 渲染也有框架注入的 `t`；命令/action 这种非 slot 场景用 `ctx.locale.bind(ns)`。

---

## 6. 客户端插件如何访问其它客户端服务

两层 `inject` 必须分清（`dsh-client-modules` 里 `parseDshClient`，`lib/client.js:62-75`；`arriveGraphRow` 加载顺序 :776-800）：

**① 包级 `package.json` 的 `dsh.client.inject`** = 一串**包名/模块 id**，保证这些 client 模块在本插件工厂之前注册（加载顺序依赖），不是 cordis 服务注入。模板见
`dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json:13-20`：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true,
              "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```

**② 模块级 `inject`** = cordis 服务键，客户端模块导出对象里的 `inject: ['commandUi','locale',…]`（模板 `templates/decoration/client.js:13-20`；`ui-conversation` 的 `inject` 在 `lib/client.js:341-349`）。服务缺失则 `apply` 等待；可选服务用 `ctx.inject([...], scope => …)`（`ui-conversation:19882`、`ui-commands:2072`）。

本项目 `/side` 需要的服务与对应包：

| 服务键 | 提供方包 | 备注 |
|---|---|---|
| `commandUi` | `@deepseek-ai/dsh-client-ui-commands` | 该包自己 `dsh.client.inject` 了 `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-input-trigger`、`@deepseek-ai/dsh-client-ui-conversation`（其 `package.json:29-39`），所以这几个包会被一并加载 |
| `locale` | `@deepseek-ai/dsh-client-locale` | |
| `sessions` | `@deepseek-ai/dsh-api-session-controller`（client half，`:3878`） | 依赖 `@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-client-file-upload`（其 `package.json:45-56`） |
| `sidebarRight`、`sidebarRightTabs` | `@deepseek-ai/dsh-client-ui-sidebar-right` | 其 `dsh.client.inject`：`api-session-controller`、`client-resources`、`ui-conversation`、`ui-layout`、`ui-session`、`client-shortcuts`（`package.json:29-41`） |
| `layout` | `@deepseek-ai/dsh-client-ui-layout` | `selectPanel / toggleSidebar / openRightbar(track, fullscreen) / closeRightbar`（`ui-layout/lib/client.js:468-489`） |
| `slots` / `uiSession` | `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-session` | 注册右侧栏 tab body 时需要 |

即：`dsh.client.inject` 至少
`["@deepseek-ai/dsh-client-ui-commands", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-client-ui-sidebar-right"]`；
模块 `inject: ['commandUi','locale','sessions','sidebarRight']`。
（自 dsh 安装目录解析的随附包不需要在 bundle 的 `dependencies` 里声明，见 `cordis-plugin-development` skill。）

---

## 7. `/side` 可直接使用的 client.js 骨架

接口全部真实；`openSideSession()` 的内部实现依赖右侧栏/会话方案（见 §8），先用占位并标注。

```js
// client.js —— 客户端半（package.json 里 "exports": {"./client":"./client.js"}）
window.__ModuleLoader__.load({
  id: '@local/side-session',
  factory(require) {
    const React = require('react');            // 自定义图标用；不自定义图标可不取

    // 图标必须是组件（会被 createElement(icon, { size: 14 }) 调用，见
    // dsh-client-ui-input-trigger/lib/client.js:1809-1812）；也可以传字符串 kind。
    function SideIcon({ size = 14 }) {
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
        React.createElement('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2, fill: 'none', stroke: 'currentColor' }));
    }

    // 右侧栏/临时对话的落点，依据 research/codex-side.md 的方案实现（见本文件 §8 待验证）
    function openSideSession(ctx, sessionId, liveSession) {
      // 例：创建/选中临时会话后，用右侧栏控制器打开一个自有 tab 类型
      // ctx.sidebarRight.openTab('local.side.session', { params: { sessionId } })
      throw new Error('openSideSession: not implemented yet');
    }

    return {
      // 模块级 cordis 服务注入
      inject: ['commandUi', 'locale', 'sessions', 'sidebarRight'],

      apply(ctx) {
        // 1) 字典（zh/en，必须包在 ctx.effect 里）
        ctx.effect(() => ctx.locale.register('local.side', {
          zh: {
            label: '侧边栏会话',
            description: '在右侧栏打开一个临时对话',
            unavailable: '当前没有可用的会话',
            failed: '打开侧边栏会话失败',
          },
          en: {
            label: 'Sidebar session',
            description: 'Open a temporary conversation in the right sidebar',
            unavailable: 'No live session available',
            failed: 'Failed to open the sidebar session',
          },
        }), 'side: dictionaries');

        const t = ctx.locale.bind('local.side');

        // 2) 注册 /side —— action 形态
        ctx.effect(() => ctx.commandUi.register({
          name: 'side',
          label: () => t('label'),               // 必须是函数：每次候选计算重新求值
          description: () => t('description'),
          icon: SideIcon,                        // 可选
          // available 同步；session 只有 { sessionId }（ui-input-trigger lib/client.js:1359-1361）
          available: (session) => ctx.sessions.binding(session.sessionId) !== undefined,
          ui: {
            kind: 'action',
            run: (session) => {
              // run 的返回值不被 await、异常不被捕获（ui-commands lib/client.js:1678-1682），自己兜住
              try {
                const live = ctx.sessions.binding(session.sessionId)?.session; // 完整 Session
                if (live === undefined) return;
                openSideSession(ctx, session.sessionId, live);
              } catch (error) {
                console.error('[side-session] /side failed:', error);
              }
            },
          },
        }), 'side: /side action');
      },
    };
  },
});
```

配套 `package.json` 片段：

```json
{
  "name": "@local/side-session",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
    }
  }
}
```

---

## 8. 右侧栏落点（与 `/side` 相关，供 task-1/3 衔接）

`ctx.sidebarRight`（`dsh-client-ui-sidebar-right/lib/client.js`）：

| 方法 | 源码 | 说明 |
|---|---|---|
| `openResource(address, options?)` | :2234 | `dsh-resource://…` 地址，按注册的 tab 类型 glob 认领 |
| `openTab(kind, options?)` | :2243 | 按**页面类型 kind** 打开，address 由包内部生成 |
| `mounted` | :2183 / `sessions.onScreen` | 当前屏幕上的 Session；**没有屏上 Session 时 `require()` 抛 `no session surface is mounted`**（:2597） |
| `close/active/isExpanded/toggleExpanded/focus/split/float/dock` | README §`ctx.sidebarRight` | 见 `dsh-client-ui-sidebar-right/README.md:93-99` |

Tab 类型注册：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted?, multiple? })`（`lib/client.js:4580`，README:83），body 用 `ctx.slots.register({ name:'sidebar.right.pane.tab', key: id }, Body)`，body 通过框架注入的 `useTabInfo()` 拿 `{ sidebar, panel, tab }`（README:84）。

**待验证 / 未确认（不要当结论用）**：
1. **临时对话如何在右侧栏内渲染**：右侧栏现有的 tab body 都跑在**屏上 Session 的 SessionProvider**下（`lib/client.js:1696-1712` 的 `SessionView`），渲染的是「某个 Session 的侧栏内容」，不是「另一个会话的对话正文」。要在一个 tab 里显示另一个临时会话，需要确认 tab body 是否拿到框架注入的 `SessionProvider`/`renderSlot`（`rightbar.session` 的 body props 由 framework renderSlot 传入，`:1707-1713`），或者另找可嵌入的会话体组件。`cordis_inspect_query` 的 Client `Slots.listSubTree` 本会话持续超时（页面未响应 inspect），无法列出 slot props，需在页面可用时补查。
2. `sidebarRight.openTab` 的参数类型 `SidebarRightTabParamsMap` 需按 kind 合并声明（README:93），外部插件只能靠 **dynamic JS** 声明，TS 合并不适用，实际是运行时未校验的 JSON。
3. app.asar 的桌面发行版**没有打包 `lib/types/**/*.d.ts`**（`read` 任意 `.d.ts` 均 not found；`package.json` 的 `files` 里列了但发行包里缺），所以本文签名来自 `lib/client.js` 的 JSDoc + 真实调用点，而非类型声明文件。若需类型级确认，要拿到 npm 包或源码 checkout。
4. Client `cordis_inspect_query`（Service/Slots）在本会话 10s 超时，未能用 inspect 交叉验证；Host inspect 正常。
5. `dsh.client.inject` 的失败语义：依赖包加载失败会让本插件报 `"<consumer>" not loaded because dependency "<dep>" failed`（`dsh-client-modules/lib/client.js:795-801`），所以列包宁少勿错（包名必须与模块 id 完全一致）。

---

## 9. 坑清单（速查）

1. `run(session)` 里的 session **只有 sessionId**；完整 Session 用 `ctx.sessions.binding(id)?.session`。
2. action **只在裸 token** 执行：`/side xxx` 静默无效（`ui-commands:1637`）。要参数请用 host 命令 + `input`/decoration。
3. `run` 同步调用、不 await、不 catch——异步逻辑自己接住错误，否则 unhandled rejection。
4. `label`/`description` 必须是函数；传字符串会 `TypeError`（`ui-commands:1549-1550`）。
5. `icon` 传**组件**（或字符串 kind），不要传 JSX 元素；尺寸由框架给 `{size:14}`。
6. contribution 与 host 命令重名会在**打开菜单时**抛 `collides with a host command`（:1546），且同名 contribution 注册时直接抛（:1454）——用 `side` 这类前缀避免撞名。
7. contribution **没有 `order`**：永远排在 Commands 区已列命令之后（Add 区 `file/goal/plan/feedback` 不受贡献影响）。
8. `available` 必须是同步 `boolean`，菜单每次合成都会调用，不要在里面发 RPC。
9. popupSelect 的 `options` 失败会留在弹层里显示错误 + 重试按钮；成功选中后 token 被消耗、聚焦回 composer（:1239-1266）。
10. `register/decorate` 的返回值必须交给 `ctx.effect`，否则插件卸载后菜单里残留死命令（内部 effect 绑在 runtime fiber 上）。
11. 本地化文案取 `t()` 的时机在渲染时；不要在 `apply` 顶层把翻译结果存成字符串常量。
12. 命令执行不会写 session log（`:1732-1747` 只本地 emit `command/executed`），因此不要在 action 里期待 host 侧出现命令记录。
