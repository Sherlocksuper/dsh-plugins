# Workspace 插件 bundle 的准确格式、client.js 模块形式与构建要求

调研范围：DSH 0.2.1-rc.3（Desktop，profile=desktop）。证据来自 skill 资料、`app.asar` 内已安装包源码/构建产物、`cordis_inspect_query` 的 host 侧查询。
本文只给结论和可复制模板，不包含任何安装/改 profile 操作。

> 配套材料：同目录 `command-api.md` 已逐行核对 `ctx.commandUi` / `ctx.remote.commands` 的完整签名与行号，`codex-side.md` 是 `/side` 的行为参考。本文负责“bundle 怎么装、client.js 怎么写、能不能构建/import”，命令与面板的具体 API 以 `command-api.md` 为准，两文互相印证。

---

## 0. 结论先行（可直接当设计要求读）

1. **一个 bundle 必须有 `dsh.bundle.patch`，并且它的 `cordis.patch.yml` 必须 insert 至少一个 Loader 行。** 即使用户看到的能力全在浏览器（只有 `dsh.client`、Host `apply(){}` 为空），也必须有这一行：客户端模块系统是**扫描 Host Loader 的存活 entry**，再读该 entry 对应包的 `package.json` 的 `dsh.client`，而不是扫描“已安装 bundle 列表”。
2. **`client.js` 不是 ESM 模块，不能写 `import`/`export`/顶层 `await`。** 它是被当 classic script 拼接下发的，顶层只执行一次
   `window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ...; return { inject, apply } } })`。
   所以**不需要构建**：手写这个文件即可，Host 原样读取字节、原样拼进 combo script 下发；本地目录安装是 link（符号链接）方式，pnpm 不会改写/打包它。
3. **`require` 能解析的只有两类**：① 平台 seed 表（实测 11 项，见 §3）；② 已登记的动态包 factory（靠 `dsh.client.external`/`dsh.client.inject` 先到货）。
   因此 `require('react')`、`require('react/jsx-runtime')`、`require('@deepseek-ai/dsh-client-ui-primitives')` 等 **技术上可行**，但 **skill 明确禁止**第三方插件 require DSH 客户端包（易随版本变化、无类型检查、组件抛错会让整个 slot entry 崩掉）。对我们插件：**只用 `react`（必要时 `react/jsx-runtime`），其余能力全部走 `ctx.*` 服务**。
4. **`dsh.client` 字段语义**：`platform` 必须是字符串 `"web"`（Desktop 也是 web，没有 `desktop` 取值；非 `web` 直接被当成“非客户端包”忽略）；`inject` 只做**包到货/激活排序**（值是客户端包 id），不提供服务注入；`external` 声明“非基线运行时依赖”（值是 `xxx/client` 或 seed 名），只影响到货顺序和清理期保留，不做构建；`immediately` 只让浏览器在 boot 预取阶段提前拉取该包脚本，功能上非必需。
5. **不要期待给 workspace 插件新增 Remote 命名空间。** Client 侧 `ctx.remote.*` 是 `@deepseek-ai/dsh-api-remotes` 在**构建期**固定导入的命名空间集合，第三方运行时插件无法追加。可用的 Host↔Client 通路只有三条（§5）：已有 Remote 命名空间（如 `ctx.remote.commands.execute`）、Host 在 `webserver/index-inject` 注入一次性全局变量、以及纯客户端逻辑（`ctx.commandUi` 命令 + `ctx.sidebarRight` 面板），最后这条是本项目最省事的方案。
6. **侧栏标签页的标准做法（两个注册）**：`ctx.sidebarRightTabs.register({ id, kind, title, ... })` + 在 `sidebar.right.pane.tab` 这个 keyed slot 里以 `key: <id>` 注册 body；打开用 `ctx.sidebarRight.openTab(kind, { params })`。真实样例：`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 与 `@deepseek-ai/dsh-client-ui-subagent`（后者就是“在右侧栏渲染一个会话”的现成范式，见 §6）。

---

## 1. 文件树与最小骨架（可直接复制）

```
my-workspace-panel/
├── package.json
├── cordis.patch.yml
├── index.js            # Host 半（可以为空 apply，或注册 Host 命令）
├── client.js           # 浏览器半（classic script + lazy factory）
├── icon.svg
├── locale/
│   ├── en.json         # Plugin Manager 显示元数据（meta.title/description）
│   └── zh.json
└── README.md           # 可选
```

> 所有文件都放在 workspace 内（例如 `<workspace>/bundle/`），由插件管理器用
> `plugin_manager({ action: "install_bundle", target: "/绝对/路径" })` 安装；**不写 profile、不手跑 pnpm**。

### 1.1 package.json（完整可复制）

```json
{
  "name": "@local/workspace-session-panel",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": false,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
    }
  }
}
```

要点：

- `exports["./client"]` 必须是**字符串**，或带**字符串 `default`** 的对象（`{types,node,browser,default}` 这种也行，但 `default` 必须有）。只有 `browser` 没有 `default` 会直接抛错。
- `dsh.client.platform` 必须精确等于 `"web"`。
- `dsh.client.inject` 是**客户端包 id 列表**（不是 Cordis service 名）；这些包会先到货、先激活。
  我们依赖 `ctx.sidebarRightTabs`/`ctx.sidebarRight` 由 `@deepseek-ai/dsh-client-ui-sidebar-right` 提供、`ctx.locale` 由 `@deepseek-ai/dsh-client-locale` 提供、`ctx.commandUi` 由 `@deepseek-ai/dsh-client-ui-commands` 提供，故写入这三项即可（写多了只会影响排序，不报错）。
- `immediately` 可省略；对我们的场景非必需（所有插件 entry boot 时都会激活；`immediately` 只是提前预取脚本）。
- `files` 只对打包/发布安装生效；**本地目录安装是 link，`files` 不过滤**，但仍建议写全。

### 1.2 cordis.patch.yml（最少一行）

```yaml
- insert:
    - id: workspace-session-panel
      name: '@local/workspace-session-panel'
```

- `id` 是 patch 行 id（唯一，便于用户在 profile patch 里 override/disable）。
- `name` 必须是**可被 Loader 解析的包名**（= package.json 的 `name`）。安装后 profile 的 `node_modules/@local/workspace-session-panel` 是指向 workspace 目录的 link，Loader 从 profile 的解析基点解析它。
- 这一行同时挂载 Host 半（`index.js`）与 Client 半（`package.json` 的 `dsh.client`）；**不需要**为 client 单独插一行。
- 如果 Host 半需要 Config 或依赖其他 Host row，可在同一 `insert` 里加；本项目不需要。
- 如果要 disable 别人的行/覆盖 config，用同文件里 `- id: ...` 覆盖块（本项目不需要）。

### 1.3 index.js（Host 半）

最小（纯客户端功能时，Host 半什么都不做，但**文件必须存在且 export apply**）：

```js
/** Workspace 面板插件的 Host 半：能力全在浏览器，Host 侧不注册任何东西。 */
export function apply() {}
```

若需要 Host 斜杠命令（`/` 命令由 Host 执行、结果写回会话），用下面这种。注意**不要 import 任何 dsh 包**，只用 ctx 服务（`CommandDefinitionId` 只是 brand 类型，运行时就是字符串）：

```js
export const name = 'workspace-session-panel';

/** 只依赖 commands 服务；服务缺失时插件保持 pending 而不是抛错。 */
export const inject = ['commands'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: '@local/workspace-session-panel:run',
        name: 'workspace-panel',
        description: '打开工作区会话面板',
        handler: async (invocation) => ({
          kind: 'success',
          text: `panel opened for ${invocation.agent.id}`,
        }),
      }),
    'workspace-session-panel: command',
  );
}
```

> Host 命令只能返回文本/错误，不能直接驱动 UI；要让命令“打开侧栏”，用 §5 的**纯客户端命令**（推荐），或由 Client 调 `ctx.remote.commands.execute(sessionId, '/workspace-panel', [])` 间接执行 Host 命令。

### 1.4 client.js（浏览器半，核心骨架）

```js
/* 浏览器半：classic script，顶层只注册 lazy factory。
 * 不能写 import/export/顶层 await；不要碰 document.body。
 * id 必须等于 package.json 的 name。 */
window.__ModuleLoader__.load({
  id: '@local/workspace-session-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TAB_KIND = 'workspace-session-panel';
    const TAB_ID = '@local/workspace-session-panel';
    const NS = 'workspaceSessionPanel';

    /* slot 占用组件由渲染器注入框架 props（真实样例里 body 拿到 useTabInfo/useResource/renderSlot/SessionProvider 等）。
     * 注册时传了 locale: NS 后，t 由框架注入；这里保留 fallback，避免未知 prop 时崩溃。 */
    function Panel({ t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            height: '100%',
            boxSizing: 'border-box',
            color: 'var(--dsw-alias-text-primary, inherit)',
            background: 'transparent',
            font: 'inherit',
          },
        },
        h('div', { style: { fontWeight: 600 } }, tr('title')),
        h('div', { style: { opacity: 0.7, fontSize: 12 } }, tr('hint')),
      );
    }

    return {
      /* 硬依赖：写成 service 名。缺少这些服务时插件保持 pending（boot 会报 “did not activate”），
       * 所以可选能力一律放 ctx.inject([...]) 里。 */
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        /* 1) 字典：动态插件用这种两语言对象形式（zh/en 必须都提供）。 */
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: { title: '工作区会话', hint: '这里将渲染临时会话。', command: '打开工作区会话面板' },
              en: { title: 'Workspace Session', hint: 'A temporary session renders here.', command: 'Open the workspace session panel' },
            }),
          'workspace-session-panel: dictionaries',
        );

        /* 2) 标签页类型（静态声明，返回 disposer）。page 类型不写 patterns；标题在打开时捕获。 */
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension', // 字符串 band，不需要 import 任何包
              title: () => ctx.locale.bind(NS)('title'),
              keepMounted: true,
            }),
          'workspace-session-panel: tab type',
        );

        /* 3) 标签页 body：keyed slot，key 必须等于上面的 id。 */
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  locale: NS,
                },
                Panel,
              ),
            ),
          'workspace-session-panel: tab body',
        );

        /* 4) 纯客户端斜杠命令：不经过 Host，直接打开面板。
         *    commandUi 由 @deepseek-ai/dsh-client-ui-commands 提供；用软注入避免它不在时整个插件 pending。 */
        ctx.inject(['commandUi', 'sidebarRight'], (scope) => {
          scope.effect(
            () =>
              scope.commandUi.register({
                name: 'workspace-panel',
                available: () => true,
                description: () => scope.locale.bind(NS)('command'),
                ui: {
                  kind: 'action',
                  run: () => scope.sidebarRight.openTab(TAB_KIND),
                },
              }),
            'workspace-session-panel: client command',
          );
        });
      },
    };
  },
});
```

骨架里刻意没做的两件事（属功能层，见 §6 与“不确定点”）：真正创建/渲染临时会话、把会话数据读进面板。这两步要先确认目标 slot 的 props 和会话渲染方式。

### 1.5 locale/en.json、locale/zh.json

这是 **Host 侧显示元数据**（Plugin Manager / 设置里的插件卡片），不是浏览器 UI 文案；浏览器文案走 1.4 里的 `ctx.locale.register`。

`locale/en.json`：

```json
{
  "meta": {
    "title": "Workspace Session Panel",
    "description": "Adds a right-sidebar tab that renders a temporary workspace session, plus a slash command to open it."
  }
}
```

`locale/zh.json`：

```json
{
  "meta": {
    "title": "工作区会话面板",
    "description": "在右侧栏新增一个标签页，用于渲染临时工作区会话，并提供打开它的斜杠命令。"
  }
}
```

### 1.6 icon.svg

任意原创/可再分发图形，`<svg>`、PNG、JPEG、WebP 均可，≤256 KiB，必须随包导出（`exports["./icon"]`）。示例：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="6" y="10" width="52" height="44" rx="8" fill="#247bbf"/>
  <rect x="14" y="20" width="24" height="4" rx="2" fill="#fff"/>
  <rect x="14" y="30" width="36" height="4" rx="2" fill="#fff" opacity=".75"/>
  <rect x="14" y="40" width="18" height="4" rx="2" fill="#fff" opacity=".55"/>
</svg>
```

---

## 2. Q1：只有 `dsh.client`、没有 Host 行为时，还要 insert Loader 行吗？

**要，必须 insert。**

证据链：

- `@deepseek-ai/dsh-client-modules/lib/index.js:105`：`scans the host Loader's entries for packages declaring dsh.client`。
- 同文件 `:558`：`for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)`（构造时把所有 Loader entry 种进 dirty 集）。
- 同文件 `:852` `processOne` / `:854`：只遍历 `ctx.loader.entries()`，对每个 entry 解析包 manifest；**没有**“遍历已安装/已选 bundle”的路径。
- 同文件 `:732`、`:737-738`：从 entry 解析出的 package.json 读 `dsh.client`，再要求 `exports["./client"]`，否则抛 `declares dsh.client but exports no "./client" bundle`。
- 同文件 `:830-841`、`:900`：拿到 clientPath 后 `readFileSync(clientPath)` 取字节快照；缺失时抛 `MissingClientBundleError`（提示 `pnpm run build`，对我们是误导——手写文件存在即可）。
- 模板 `templates/decoration/cordis.patch.yml` 本身也 insert 了一行，`index.js` 是空的 `apply(){}`。

结论：bundle 的 patch 是“装载入口”；`dsh.client` 只是**已被装载的那个包**的附加声明。没有 loader 行 = 浏览器端永远不加载 client.js。

---

## 3. Q2：client.js 的模块形式与 require 的可用 specifier

### 3.1 模块形式（权威证据）

模板 `templates/decoration/client.js`：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) { ...; return { inject: ['slots'], apply(ctx) { ... } }; },
});
```

- 宿主把每个包的 client.js 字节**原样**拼进 `/plugins/??...` combo script（`client-modules/lib/index.js:336-341` `buildComboScript`），combo 是 class script；因此 **不能有 ESM 语法**，也不能有顶层 `await`。
- 执行 bundle 只**注册 factory**；factory 在首次 materialize 时才跑（`lib/client.js:701-714` `register`、`:803-830` `materialize`）。所以顶层保持“仅一次 load 调用”，把副作用全部放进 factory/apply。
- factory 返回值就是该包的模块导出面；插件面是 `{ inject?, apply, name?, Config? }`（Cordis 插件形态）。`id` 会被 `stripClientSuffix` 处理，`<pkg>/client` 与 `<pkg>` 同义。
- **单文件**：手写 bundle 不能用相对 `require('./x.js')`（只有构建器生成的 `client.<name>.js` chunk 才能被 `require.async` 加载）。所有代码放一个 client.js。

### 3.2 `require` 的三级解析（证据：`client-modules/lib/client.js`）

`:832-850` `makeRequire`：

```js
const require = (spec) => {
  edges.add(spec);
  if (this.seed.has(spec)) return this.seed.get(spec);          // ① 平台 seed 表
  const id = stripClientSuffix(spec);
  const record = this.loadCache.get(id);
  if (record !== void 0) return record.exports;                 // ② 已 materialize 的动态包
  if (this.factories.has(id)) return this.materialize(id).exports; // ③ 已登记 factory（已到货）的动态包
  throw new Error(`client-modules: require("${spec}") missed the module table ...`);
};
```

`:681` `this.seed = new Map(Object.entries(options.staticModules))`；`:988` 从 boot options 取。
`options.staticModules` 由 shell 提供，实测表在
`@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 的 `function OZ()`（单行压缩，约 920k 偏移）：

```js
{
  react, 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', zod, '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
}
```

**确切答案：**

- `'react'`、`'react/jsx-runtime'`、`'react-dom'`、`'react-dom/client'`、`'@deepseek-ai/cordis'`、`'zod'`、`'@tanstack/react-virtual'`、`'@deepseek-ai/dsh-client-store'`、`'@deepseek-ai/dsh-client-ui-slots'`、`'@deepseek-ai/dsh-client-ui-primitives'`、`'@deepseek-ai/dsh-client-ui-dockkit'` → **可以直接 require**。
- 其他 `@deepseek-ai/dsh-client-*` 包：**技术上可以**，但前提是它已被登记进 boot graph 并已经到货。到货规则：`arriveGraphRow`（`:777-794`）先到货 `external` 列表里的包，`inject` 列表里的包也会先到货；否则同步 `require` 会 miss（③ 不成立）。也就是说需要在自己的 `dsh.client.external` 里写 `<pkg>/client`（真实样例：`dsh-client-ui-voice-input` 的 `external: ["@deepseek-ai/dsh-api-gateway/client"]`）。**但 skill 明确禁止**：`references/practices.md:35`“Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed.” 原因：这些包随时改、纯 JS 插件没有类型检查、组件抛错会让整个 slot entry 白屏。
- 对我们插件：**只 require `'react'`（需要 jsx-runtime 时再加）**；侧栏、命令、locale、会话全部用 `ctx.*` 服务，不 import 任何 DSH 客户端包。

---

## 4. Q3：`dsh.client` 字段语义与真实样例

扫描器实现：`parseDshClient`（`dsh-client-modules/lib/index.js:62-76`），校验极简：

| 字段 | 类型 | 语义（实现视角） |
|---|---|---|
| `platform` | string，**必须 `"web"`** | `:733` `if (decl === void 0 || decl.platform !== 'web') return null`。Desktop 壳也按 web 加载；“desktop”等其它值 = 当作没有客户端半，静默不加载（排查时最容易踩的坑）。 |
| `inject` | string[] 可选 | 客户端**包 id** 列表，只用于 boot graph 的到货顺序（`client.js:789-792`：先把这些包的 factory 注册好，再登记自己）+ 清理期保留（`:944-948`）。**不是服务注入**；服务注入写在模块导出的 `inject: ['slots', ...]`。 |
| `external` | string[] 可选 | 声明“非 seed 表的运行时 require”。用于 `orderByModuleGraph` 排到货顺序（`index.js:422-444`）以及 `prune` 保留（`client.js:944-948`）。运行时实现只对“自引用”和“同步环”抛错；写了当前未启用的包名会被静默跳过（到真正 `require` 时才报 miss）。README 说的“拒绝 missing suppliers”更接近构建期约束，插件打包场景需以运行时行为为准。 |
| `immediately` | boolean 可选 | 使该包进入 boot 预取层（`web-frontend` 的 `prefetchImmediateTier`：`manifest.plugins.filter(e => e.immediately).map(e => modules.prefetch(e.id))`），即页面启动时提前拉脚本。不影响能力，只是首屏/首用速度。 |

真实样例（从 asar 里 79 个声明 `dsh.client` 的包中挑）：

```jsonc
// @deepseek-ai/dsh-client-modules（最小声明）
"dsh": { "client": { "platform": "web", "inject": [], "immediately": true } }

// @deepseek-ai/dsh-client-ui-sidebar-right（我们依赖的侧栏服务提供者）
"dsh": { "client": { "platform": "web",
  "inject": ["@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-client-resources",
             "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-layout",
             "@deepseek-ai/dsh-client-ui-session", "@deepseek-ai/dsh-client-shortcuts"] } }

// @deepseek-ai/dsh-experimental-client-ui-voice-input（external 的真实写法）
"dsh": { "client": { "platform": "web",
  "external": ["@deepseek-ai/dsh-api-gateway/client"],
  "inject": [..., "@deepseek-ai/dsh-api-gateway", ...] } }
```

另外注意 `exports["./client"]` 的解析只接受字符串或带字符串 `default` 的对象（`index.js:171-182`），文档型 `{types,node,browser,default}` 只能靠 `default` 兜底。

---

## 5. Q4：需要 pnpm install / 构建吗？安装时 client.js 会被二次打包吗？

**不需要构建，也不会二次打包。**

- 安装路径：`plugin_manager install_bundle` → `@deepseek-ai/dsh-plugin-manager` 的 `installBundle(spec, options)`（`lib/index.js:1970`），它执行 `pnpm add <spec> [--save-exact] ...`（`:2033`），随后 `selectBundle(name, true)`（`:2091`）把 bundle 写进 profile 的 `dsh.profile.bundles`，并加载其 patch 行（`bundlePatchPaths`/`loadOverlayPatches`，`:10` 的 import 与 `:2072` 附近）。
- 传绝对目录时 pnpm 记录为本地 link（skill `host-plugin.md:35`：“Local directory installation links the checkout instead, so check the files directly; `files` does not filter a linked directory”）。也就是 profile 的 `node_modules/@local/xxx` 符号链接到 workspace 目录。
- client 半的加载是**文件读取**：`resolveMeta` 把 `exports["./client"]` 解析成绝对路径（`index.js:737-747`），`initialBundleSnapshot` 直接 `readFileSync(clientPath)`（`:830-841`），`rebuilt()` 也直接读文件（`:625-643`）。没有 tsdown/vite 参与，没有“重建”概念。
- Host 半同理：Loader 用 Node ESM import 直接加载 `index.js`，所以 `index.js` 必须是 Node 能直接跑的 ESM（`"type": "module"`），不能有 TS/JSX。
- 唯一和“构建”沾边的地方：对于用 tsdown 构建的正式包，bundle 缺文件时报错会提示 `pnpm run build`；我们是手写文件，只要 `exports["./client"]` 指向的文件真实存在即可。

安装后的生效行为（skill `host-plugin.md:68-70`）：

- **新装 bundle**：可经 HMR 直接激活，不一定需要重启。
- **替换已安装的同名包**：必须重启 Harness 才会加载新的 JS 模块代。
- 由于本地是 link，**改 client.js 可能被 Client HMR 感知**（graph 以文件 mtime/ctime/size 算 rev），但改 `index.js`（Host）通常要重启；若页面刷新后行为没变，先重启再判断。这一点列为待验证项。

---

## 6. 侧栏标签页与会话渲染的准确接法（功能骨架依据）

### 6.1 标签页类型 + body（真实样例，`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`）

```js
const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'configForms', 'resources'];

function apply(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), 'ui-sidebar-documentpreview: text type');
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '...: dictionaries');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TEXTPREVIEW_ID,
    locale: NS,
    store,                       // 可选：tab 级 store（客户端状态）
    children: {                  // 可选：本 tab 内再开子 slot
      'sidebar.right.tab.document': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: ... } } },
      'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
    },
  }, PreviewBody)), '...: tab body');
}
```

类型注册的完整签名（`dsh-client-ui-sidebar-right/README.md:83`）：
`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`，返回 disposer。

- `id` 是这个实现在 tab 系统里的唯一身份（用包名最自然），也是 body 注册时 `key` 的取值；重复注册同 id 会抛错。
- 页面型 tab（我们这种）不写 `patterns`，用 `kind` 打开：`ctx.sidebarRight.openTab(kind, { params?, paneId?, replaceTab?, revealIfOpened? })`。
- `priority` 是 `"extension" | "builtin" | "fallback"` 字符串，不需要 import。
- `title(address)` 在打开时捕获（`t` 可用）；`guide` 会给“引导页/更多工具”贡献卡片。

### 6.2 “在右侧栏渲染会话”的现成范式（`@deepseek-ai/dsh-client-ui-subagent/lib/client.js`）

```js
ctx.effect(() => ctx.resources.register(subagentChatResourceProvider(ctx.sessions)), '...resources');
ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'subagentchat', patterns: [...], priority: 'builtin',
  canOpen: (address) => parse... !== undefined, title: (address) => ... }), '...type');
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab', key: SUBAGENT_CHAT_ID,
  children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
}, SidebarChatTab)), '...body');
ctx.effect(() => ctx.slots.inject('sidebar.chat.conversation', () => ctx.slots.register({
  name: 'sidebar.chat.conversation', id: ..., /* ... */
}, FixedChatConversationView)), '...conversation view');

function SidebarChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo();
  const resource = useResource(tab.contentId);
  return h('div', { className: 'root', 'data-sidebar-chat': '' },
    resource.value === undefined ? null :
      h(SessionProvider, { session: resource.value.reference },
        renderSlot('sidebar.chat.conversation', {})));
}
```

要点：

- slot 占用组件拿到的是**渲染器注入的框架 props**（真实样例里出现过 `useTabInfo`、`useResource`、`renderSlot`、`SessionProvider`；注册时给 `locale: NS` 还会注入 `t`）。写视图前应该用 `cordis_inspect_query({platform:'client', provider:'Slots', method:'listSubTree', input:{root:'sidebar.right.pane.tab'}})` 拿到该 slot 的 props 契约（我这边 client inspect 一直超时，未能取得，见 §8）。
- 会话内容的渲染走 `conversation.content` 这个 **factory slot**：`renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots: { views: FixedChatConversationView } })`；这些 helper 也是框架注入的。
- “临时会话”的原料在客户端已有：`ctx.sessions.create({ cwd?/workspaceId?, agentPreset? })` 返回 sessionId（`dsh-api-session-controller/lib/client.js` 的 sessions 服务），`ctx.sessions.retain(id, { source })` / `using(...)` 拿引用；Host 侧对应 `remote.session.create`。注意 create 出来的是**真实持久会话**（会出现在左侧列表），如需“用完即弃”需另设计清理（归档/删除），这是功能决策点。

> 由于会话渲染细节属于功能层（另有任务在查），本文只给接入位置，不把 `conversation.content` 用法写进“可直接复制”的骨架，避免把未验证的 props 固化。

---

## 7. Host↔Client 通路的真实约束（重要设计结论）

- Client 侧 `ctx.remote.<ns>.<method>` 是**构建期固定**的：`@deepseek-ai/dsh-api-remotes` 的 Client entry “imports generated `/remote` artifacts as runtime values, mounts each contribution through `ctx.remote.$mount()`”，并把能力集合写死在 assembly 里（README “Known Limitations: The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime”）。**workspace 插件没法在运行时新增 Remote 命名空间**（没有 tsdown 生成 `/remote`）。
- 若需要“UI 按钮触发 Host 操作”，用**已有命名空间**：最方便的是命令：
  `ctx.remote.commands.execute(sessionId, '/cmd args', [])` → `{ ok, value: { result: { kind, text } } }`（真实用法见 `dsh-client-ui-commands/lib/client.js` 的 `execute(session)`）。Host 侧则由 `ctx.commands.register(...)` 提供命令（见 `dsh-command-compact/lib/index.js`：`ctx.commands.register({ definitionId, name, description, handler })`，`inject = ['commands', ...]`）。这也符合 skill 的 `references/user-actions.md`：一个操作只在 Host 实现一次，UI 通过 session command 调它，Agent tool 调同一个方法。
- 若需要 Host 把**配置/数据在 boot 时**交给浏览器，用 `webserver/index-inject` 注入全局变量（真实样例 `dsh-client-ui-sidebar-documentpreview/lib/index.js:20-33`）：
  ```js
  function apply(ctx, config) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_MY_PLUGIN_CONFIG__', value: config });
    });
  }
  ```
  浏览器侧读 `globalThis.__DSH_MY_PLUGIN_CONFIG__`。只在下一次页面加载时生效。
- 纯客户端功能（打开面板、切换视图）**不需要**任何 Host 来回：用 `ctx.commandUi.register(...)`（ui-commands 的客户端服务，`inject = ['inputTriggers','sessions','remote','remote.commands','locale']`，方法 `register(contribution)` / `decorate(decoration)`）就能拿到一个 `/` 命令。contribution 形状（从实现反推）：
  `{ name, available(session), label?(), description?(), icon?(), ui: { kind:'action', run(session) } | { kind:'popup', ... } }`。
  这正好适合“斜杠命令 → 打开右侧栏面板”。

---

## 8. 不确定点 / 需要在实现阶段验证

1. **`sidebar.right.pane.tab` 的 body props 契约**：我这边 `cordis_inspect_query` 的 **client 全部超时**
   （`Builtin.listBuiltins`、`Slots.listSubTree`、`Service.listService` 均在 10s 超时；页面在本地回环端口打开，但部分会话拿不到 client 通道）。
   验证办法（实现者执行）：`cordis_inspect_query({platform:'client', provider:'Slots', method:'listSubTree', input:{root:'sidebar.right.pane.tab'}})`，同时 `Builtin.listBuiltins` 复核 seed 表。
2. **`conversation.content` factory slot 的第三方用法**：`renderFactorySlot`/`views`/`SessionProvider` 是 ui-subagent 的内部用法。第三方插件能否以同样方式渲染会话，需要看该 slot 的公开注册选项（用上面 Slots 查询确认），否则退化为“面板内自绘 UI”的首版。
3. **“临时会话”的生命周期**：`ctx.sessions.create` 建的是持久会话（进入列表）。若要求“不落列表/用完销毁”，需要另外设计（归档、专用 cwd、或仅内存展示），目前没有查到官方“临时会话”类型。
4. **本地 link 包的 HMR 行为**：client.js 改动是否能被 `@deepseek-ai/dsh-client-hmr` 感知（graph rev 基于 mtime/ctime/size），以及 Host index.js 改动是否必须重启——未实测。建议实现时：改 client.js 后先刷新页面；改 index.js 后重启 Harness；`install_bundle` 替换同名包必须重启。
5. **`dsh.client.inject` 写什么最稳**：写包名只会影响到货/激活顺序；若写了一个当前 profile 未启用的包，`arriveGraphRow` 的依赖查找会落空（`graphRows.get` 未命中就跳过），不会报错，但排序效果消失。因此只写我们确实依赖的 `dsh-client-locale`、`dsh-client-ui-commands`、`dsh-client-ui-sidebar-right` 三项即可。
6. **命令名冲突**：`commandUi` 的 contribution 与 Host 命令同名会抛 `collides with a host command`；`name` 建议带前缀（如 `workspace-panel`）。
7. **locale 元数据语言回退**：`meta.title/description` 支持 `LocalizedText`（小写语言 id、必须有 `en` 回退）；`zh.json` 与 `en.json` 字段必须一致，否则可能回退到包名/默认图。

---

## 9. 安装与验证清单（含审批点）

1. **不改 profile、不手跑 pnpm**：调用
   `plugin_manager({ action: 'install_bundle', target: '<workspace 绝对目录>' })`
   （该动作在无 Full access 时需要审批；当时的会话无法弹出审批，未执行任何安装）。
   若返回 `pendingBuilds`，只有用户明确同意后才能传 `approvedBuilds`（我们的插件没有 install script，正常不会有）。
2. 读返回的 `application`：`applied` 才算生效；`restart-required` 表示必须重启；`failed` 看 `warnings`。
3. **免审批确认行已挂载**：`cordis_inspect_query({platform:'host', provider:'Config', method:'listConfigs', input:{name:'@local/workspace-session-panel'}})` 应出现我们的 entry。
4. **客户端确认**：client `Slots.listSubTree` 看 `sidebar.right.pane.tab` 下是否出现我们的 key；页面里试 `/workspace-panel` 是否出现并打开面板。
5. **显示元数据**：Plugin Manager / Settings 里确认 title/description/icon（zh 与 en）；无浏览器控制时只能检查导出的 locale/icon 文件，并报告“渲染未验证”。
6. **纯客户端命令/面板**：在页面里输入 `/workspace-panel`，确认右侧栏出现我们的标签页；关闭再开，确认 disposer 正常（无重复注册报错）。
7. 语法自检（不安装、不依赖网络）：
   ```bash
   node --check bundle/index.js        # 在 "type":"module" 包内按 ESM 解析
   node --check bundle/client.js       # classic script；若误用 import/export 会立刻报错
   node -e "JSON.parse(require('fs').readFileSync('bundle/package.json','utf8'))"
   node -e "for (const f of ['en','zh']) JSON.parse(require('fs').readFileSync('bundle/locale/'+f+'.json','utf8'))"
   ```
   （“不安装”的意思是用 workspace 内的副本自检；skill 也要求在 workspace 内检查，不要在 asar 里原地跑。）

---

## 10. 关键证据索引

| 结论 | 证据 |
|---|---|
| client 半只扫描 Loader entries，不扫 bundle 列表 | `dsh-client-modules/lib/index.js:105, 558, 852-854` |
| `dsh.client` 解析与 `platform==='web'` 门禁 | 同上 `:62-76, 732-738` |
| `exports["./client"]` 只认字符串/字符串 default | 同上 `:171-182` |
| client bundle 原样读文件（无构建） | 同上 `:830-841, 900, 625-643` |
| combo script 原样拼接（classic script） | 同上 `:336-341, 460-504` |
| seed 表 11 项（react/primitives/slots/store/dockkit/cordis/zod/react-virtual） | `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 内 `function OZ()` |
| `require` 三级解析、external/inject 到货顺序 | `dsh-client-modules/lib/client.js:681, 777-794, 832-850, 988` |
| 禁止 require DSH 客户端包 | skill `references/practices.md:35` |
| client.js 模板（lazy factory） | skill `templates/decoration/client.js`；`dsh-client-modules/lib/client.js:1-3`（同一形式） |
| 侧栏 tab 两段式注册 | `dsh-client-ui-sidebar-right/README.md:81-95` |
| 会话 tab 真实实现范式 | `dsh-client-ui-subagent/lib/client.js`（`registerSidebarChat`、`SidebarChatTab`） |
| 客户端命令服务 | `dsh-client-ui-commands/lib/client.js`（`CommandUiRuntime.register/decorate`、`inject=['inputTriggers','sessions','remote','remote.commands','locale']`） |
| 客户端调 Host 命令 | 同上 `execute(session)` → `ctx.remote.commands.execute(...)` |
| Host 命令注册 | `dsh-command-compact/lib/index.js`（`inject=['commands']`、`ctx.commands.register`） |
| Host 命令 Remote 契约 | `cordis_inspect_query(host, Service, {service:'commands'})`（`register/list/execute` 签名） |
| Host→Client boot 全局注入 | `dsh-client-ui-sidebar-documentpreview/lib/index.js:20-33`（`webserver/index-inject` + `kind:'global'`） |
| 安装 = `pnpm add` + 选 bundle + 加载 patch | `dsh-plugin-manager/lib/index.js:1970, 2020-2033, 2091, 2072` |
| 本地目录 = link、files 不过滤 | skill `references/host-plugin.md:35` |
| 新装可 HMR、替换需重启 | skill `references/host-plugin.md:68-70` |
| locale/icon 显示清单 | 同上 `:29-55` |
