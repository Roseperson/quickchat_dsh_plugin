# QuickChat 作为 DSH 右侧栏 tab 的集成方案（0.2.1-rc.2 实测/源码分析）

> 目标：把 `dsh-quickchat` 从「右下角 fixed 浮窗」升级为 DSH 原生右侧栏 tab，复用现有 host API 与 UI，给出可直接指导实现的 API 契约、最小代码、分阶段清单与风险。
>
> 权威依据：用户运行的 DSH 桌面 App **v0.2.1-rc.2** 解包源码 `/tmp/dsh-021/dsh/node_modules/@deepseek-ai/`（下称 `$AI`），其中 `@deepseek-ai/dsh-desktop-runtime` 版本见 `/tmp/dsh-021/dsh/package.json:1-4`。第三方插件仓库 `/Users/gc/dsh-plugin-quickchat` 未做任何修改，本文件是唯一产出。
>
> 标注约定：**【确证】**＝源码/官方 contract 直接证明；**【推断】**＝由源码推断，需按文末验证方法在冒烟实例确认；**【实测】**＝Lead 已在 0.2.1-rc.2 隔离实例验证。
>
> ⚠️ 行号说明：文中行号基于**分析时的工作区快照**（仓库内可能有多人并发改动 `client/client.js`，行号会漂移）。实施时请以**符号名 grep** 为准（例如 `registerClient`、`panelStore`、`plugin.inject`、`settingsScope`）。本文档只写 `docs/`，未修改 `client/`、`lib/`、`tests/`。

---

## TL;DR（给实现者的 10 行结论）

1. **可行，且没有白名单**【确证】`: `ctx.sidebarRightTabs.register({...})` 是公开的两段式扩展点，注册器只校验 `id`/`kind` 冲突与 `guide` 内 id 重复，没有任何包名/权限校验；第三方类型默认落在最高优先级的 `extension` band。官方 `ui-sidebar-documentpreview` 就是「另一个包走同一公开路径」的活证据。
2. **推荐参数**：`kind: "quickchat"`、`id: "dsh-quickchat"`、无 `patterns`（页面型）、`keepMounted: true`、`multiple` 省略（=false）、`priority` 省略（默认 `extension`）、`title: () => t("quickChat")`、`guide: [{ id: "panel", commandId: "quickchat.open", order: 40, ... }]`。
3. **两段式**：① `ctx.sidebarRightTabs.register(definition)` 声明类型；② `ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name, key: definition.id, locale, ... }, Body))` 注册 body；③（可选）`sidebar.right.pane.tab.title` 注册动态标题。两段都必须包在 `ctx.effect` 里。
4. **body 拿上下文的唯一正确方式**：props 里有 `sessionId` 与标准 hooks（`useSessions`/`useWorkspaces`/`useSession`…），并通过注入的 `useTabInfo()` 读 `{ sidebar, panel, tab }`（含 `tab.navigation.params`、`tab.signal`、`tab.actions.openResource/openTab/close/bindCommands`、`tab.visible`）。`sessionId` 是**该 tab 所在 session**，不是全局 current——project 解析必须用它。
5. **打开入口**：`ctx.sidebarRight.openTab("quickchat")`（页面型无 address）；`openResource(address, options)` 只用于资源型。`openTab` 会自动展开右侧栏、页面型 tab 在目标 pane 内去重。
6. **第三方触发入口**：保留现有 `conversation.input.right` 按钮（session 作用域，`sessionId` 存在时渲染），点击改为 open/focus tab；加 `ctx.shortcuts.register`（id 与 guide entry 的 `commandId` 联动显示快捷键）；`conversation.session.header.corner` 是 **single 且已被右侧栏展开按钮占用，禁止第三方占用**；如要在 header 加按钮，用 list 型 `conversation.session.header.actions` / `.utilities`。
7. **P0 前置（与 tab 无关也必须先修）**：`client/client.js` 的 `plugin.inject` 里 `'settingsScope'` 在 0.2.1-rc.2 已不存在 → 整个 client 插件 pending、web boot 报错【实测】；`settings.plugin.item` slot 也不存在。必须移除 + 迁移设置卡片（新 API：`plugins.row.config` + `ctx.configForms`），否则后续任何 UI 改造都看不到效果。
8. **状态冲突**：右侧栏布局是 **per-session**（localStorage `dsh.sidebar-right.v1.<sessionId>`），quickchat 数据是 **per-project**（host 磁盘）。tab body 必须按自己的 `sessionId` 解析 project；同一个 project 的多个 session 各有一个 tab/body，host 数据共享、body 本地状态（当前会话、草稿、流式）各自独立。
9. **多实例风险**：`keepMounted: true` 时，切换 session 后后台 session 的已初始化 body 仍会挂载【确证 README】，因此**必须去掉当前模块级 `panelStore` 单例**，改为每个 body 自建 controller/state，否则两个 session 的 quickchat 会串状态。
10. **无 session 行为**：右侧栏没有 surface（`mounted === undefined` 时 `openTab` 抛错 "sidebarRight: no session surface is mounted"），因此 sessionless hero 无法打开 tab；方案保留旧浮窗作为降级（Phase 1），Phase 2 再决定是否用 `float(tabId)` 或移除。

---

## 目录

- [1. 右侧栏架构与证据地图](#1-右侧栏架构与证据地图)
- [2. 两段式注册契约（Q1）](#2-两段式注册契约q1)
- [3. 打开、聚焦与第三方入口（Q2）](#3-打开聚焦与第三方入口q2)
- [4. 第三方开放性与装配要求（Q3）](#4-第三方开放性与装配要求q3)
- [5. QuickChat 集成方案（Q4）](#5-quickchat-集成方案q4)
- [6. 分阶段落地清单](#6-分阶段落地清单)
- [7. 风险与未决问题](#7-风险与未决问题)
- [8. 其他官方 workspace/右侧栏扩展面盘点（Q5）](#8-其他官方-workspace右侧栏扩展面盘点q5)
- [附录 A：证据索引](#附录-a证据索引)
- [附录 B：quickchat 现状代码地图](#附录-bquickchat-现状代码地图)
- [附录 C：验证方法](#附录-c验证方法)
- [附录 D：推断与未确证项](#附录-d推断与未确证项)

---

## 1. 右侧栏架构与证据地图

### 1.1 包与职责

| 包 | 作用 | 证据 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-sidebar-right` | 右侧栏：每 session 一个 docking surface、`ctx.sidebarRight` 导航控制器、`ctx.sidebarRightTabs` tab 类型注册表、Tab domain、guide 类型 | `$AI/dsh-client-ui-sidebar-right/README.md:12` |
| `dsh-client-ui-sidebar-files` | 页面型 tab（文件树），最小完整两段式范例 | `.../lib/client.js:15-35,934-1024` |
| `dsh-client-ui-sidebar-terminal` | 页面型 `multiple: true` tab + 自定义 guide 卡片 + close handler | `.../lib/client.js:350-493` |
| `dsh-client-ui-sidebar-browser` | 页面型 `multiple: true` + 条件 `keepMounted` + 取 actions 的 `inject` | `.../lib/client.js:1430-1454,1603-1645` |
| `dsh-client-ui-sidebar-documentpreview` | **另一个包用公开路径注册类型的活证据**（资源型 fallback + 嵌套 document seat） | `.../lib/client.js:1076-1088,7180-7258`；README 首页第 83 行 |
| `dsh-client-ui-layout` / `dsh-client-ui-renderer` | 三栏 AppFrame、slots 服务（`ctx.slots`） | `$AI/dsh-client-ui-renderer/lib/client.js:1305-1440,1598-1650` |
| `dsh-cordis-client-runner` | 由源码 AST 生成的 **contract 目录**：每个 slot 的 kind/scope/registerOptions/ownerProps/standardProps/occupants（很适合当权威 contract 查） | `$AI/dsh-cordis-client-runner/lib/client.js:1125-6500` |
| `dsh-client-modules` | `dsh.client` 声明 → 浏览器 bundle 装载、`__DSH_BOOT__` 图排序 | `$AI/dsh-client-modules/README.md`；`lib/index.js:67,414-437`；`lib/client.js:776-796` |

### 1.2 三个关键事实

1. **每 session 一个 surface，section 级 store**：`SurfaceState` 按 session id 保存布局，localStorage key `dsh.sidebar-right.v1.<sessionId>`；`rightbar` slot 是 root single，`rightbar.session` 是 session single（`$AI/dsh-client-ui-sidebar-right/lib/client.js:4913-4960`；README:61,74）。
2. **没有 session 就没有右侧栏**：`SidebarRightController.require()` 在没有 on-screen session 时抛 `sidebarRight: no session surface is mounted`（`client.js:2479-2488`）；README:142 "No surface without a session"。
3. **tab 内容完全由注册表分发**：pane 里每个 tab 通过 keyed slot `sidebar.right.pane.tab` 用**类型 in-force 的 `id`** 分发 body，`sidebar.right.pane.tab.title` 分发 chip 标题；sidebar-right 自身不含任何具体类型代码（`client.js:1253-1338`；README:84）。

### 1.3 seat 声明与类型注册的绑定关系

`rightbar.session` 是 seat，它的 children 声明了本包可用的扩展座位（`client.js:4925-4945`）：

```js
yield ctx.slots.register({
  name: "rightbar.session",
  locale: NS,
  children: {
    "sidebar.right.pane.tab":       { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
    "sidebar.right.pane.tab.title": { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
    "sidebar.right.tab.menu.item":  { kind: "list",  scope: "session" },
  },
  store,
  inject: (sessionId) => ({ ...injected, ... }),
}, RightbarSeat);
```

`TabSlot` 按 `definition.id`（不是 kind）分发（`client.js:1253-1300`）：

```js
const content = renderSlot(seat, {}, {
  entryKey: definition?.id ?? tab.kind,
  fallback,
  hookContext,   // { tabId, shortcuts, title, fullscreen, active, signal, actions, useStore, useTabNavigation }
});
```

因此 **`id` 既是注册表唯一键，也是 body/title 的 slot key**。

---

## 2. 两段式注册契约（Q1）

### 2.1 阶段 1：`ctx.sidebarRightTabs.register(definition)` 字段表

注册表实现：`$AI/dsh-client-ui-sidebar-right/lib/client.js:4440-4630`；contract 文档：`README.md:81-88,104-121`。

| 字段 | 类型 | 语义 / 约束 | 证据 | quickchat 建议 |
|---|---|---|---|---|
| `id` | `string`（必填） | 该实现的全局唯一身份；**body/title slot 的 key**；重复注册抛 `tab type id "…" is already registered` | `client.js:4465-4469`；README:83 | `"dsh-quickchat"`（包名，最自然） |
| `kind` | `string`（必填） | tab 类型判别符；写入布局记录（`tab.kind`）。同一 kind 最多「一个 builtin + 一个 extension」共存；同 band 第二个、或和 fallback 冲突 → 抛错 | `client.js:4405-4410,4471-4472`；README:83 | `"quickchat"`（小写、不叫 `guide`） |
| `patterns` | `string[]`（可选） | 资源型才有：picomatch glob，**含 `:` 匹配整条 address**（`dsh-resource://file/**`），**不含 `:` 匹配 URI path 的 basename、任意深度、忽略大小写**（`*.md`）；页面型省略 | `client.js:4413-4436`；README:83 | **省略**（页面型，通过 `openTab` 打开） |
| `priority` | `"extension" \| "builtin" \| "fallback"`（可选，默认 `"extension"`） | 资源认领排序 band；`extension`=产品外类型（最高）；只影响资源 claim 排序与同 kind 覆盖，不影响页面型打开 | `client.js:4394-4401`；README:86 | **省略**（默认 extension 最高，无需覆盖任何 builtin） |
| `canOpen` | `(address) => boolean`（可选） | 资源匹配后的否决器；`claim` 时若 veto 则抛/跳过 | `client.js:4557-4608`；README:83 | 省略 |
| `title` | `(address) => string`（必填） | tab chip 文本，**打开时捕获**（之后不随语言变化，除非注册 title seat）；页面型收到 `sidebar://<kind>`；`multiple` 型收到带 uuid 的 address | `client.js:585-596,604-608,2185-2191`；README:93,146 | `() => t("quickChat")`（t 来自 `ctx.locale.bind(NS)`，每次调用重新取语言；但 chip 文字仍是打开瞬间的快照） |
| `guide` | `entry[]`（可选） | guide 页里的入口卡片；`id` 在本 provider 内唯一；按 `order` 升序排；字段 `{id, order, title():string, description?():string, icon?:Component, commandId?:string}`；`commandId` = shortcuts id，用于卡片右侧显示快捷键；选中卡片会 `openTab(entry.kind, { replaceTab: true })` | `client.js:4619-4626,507-545`；README:115,119；examples：files `client.js:30-34`、terminal `444-450`、browser `1441-1448` | 加一个 entry：`{ id: "panel", commandId: "quickchat.open", order: 40, title: () => t("guideTitle"), description: () => t("guideDescription") }`；`icon` 可省略（渲染占位方块） |
| `keepMounted` | `boolean`（可选，默认 false） | 保留访问过的 body：切换 tab、切换 session、收起侧栏、docking 都不卸载；未访问过的 body 不会预挂载 | `client.js:1253-1266`；README:106 | **true**：保住流式输出/草稿，切 tab 不中断 |
| `multiple` | `boolean`（可选，默认 false） | 每次 open 生成独立 contentId：`sidebar://<kind>/<uuid>`，拥有独立实例；页面型普通 tab 在「目标 pane」内唯一 | `client.js:2185-2188`；README:117 | **省略（false）**：一个 pane 一个 quickchat；如需「一 chat 一 tab」Phase 2 再开 |
| （其他字段） | — | 注册器只读上述字段，未知字段被忽略（`definition` 原样存入 entry） | `client.js:4473-4481` | — |

**冲突与错误规则汇总**【确证】（`client.js:4465-4535`）：

- `id` 全局重复 → throw。
- 同一 `kind` 已存在：若「现存 in-force band = fallback」或「新 band = fallback」或「同 band」或「已有 shadowed」→ throw；仅当「builtin ↔ extension 各一个」才允许共存，**extension 生效、builtin 被 shadow，extension 卸载后 builtin 自动恢复**。
- `guide` 内部 `id` 重复 → throw。
- 页面型 `openTab` 遇到未注册 kind → throw `no tab type is registered as "…"`（`client.js:2185-2188`）。

### 2.2 阶段 2：body / title 的 slot 注册

**slot 名与 key**【确证】：
- body：`name: "sidebar.right.pane.tab"`，`key: <definition.id>`。
- 标题：`name: "sidebar.right.pane.tab.title"`，`key: <definition.id>`（可选，缺省显示打开时捕获的 title）。
- 另外两个可选座位：`sidebar.right.tab.guide.entry`（keyed，自定义 guide 卡片，`key = definition.id`）；`sidebar.right.tab.menu.item`（list，tab 右键菜单追加项）。

**slot register options 通用字段**（来自 renderer 的 `SlotRegistry` 实现与合同目录）：`name`、`key`/`id`/`select`（按 slot kind 三选一）、`order`、`label`、`locale`（为组件注入 `t`）、`store`（`StoreSpec` → 组件得到 `useStore`/`actions`）、`inject`（`(sessionId, actions?) => ownerInjected`，见 2.4）、`children`（声明嵌套子座位，仅当类型自己要开子座位时需要）、`hooks`（经 `inject: { hooks }` 转成 `useXxx` props）。证据：`$AI/dsh-client-ui-renderer/lib/client.js:1305-1440,1598-1650`；contract：`dsh-cordis-client-runner/lib/client.js:5748-5849`；官方写法：files `client.js:1003-1021`、terminal `475-489`、browser `1610-1645`、documentpreview `7220-7258`。

**必须用 `ctx.slots.inject(slotName, () => ctx.slots.register(...))` 包住**：座位由 sidebar-right 在 `rightbar.session` 注册时**声明**，`ctx.slots.inject` 会等声明出现（若 sidebar-right 未启用则一直等待且不报错），回调里再 `ctx.slots.register`；整个回调在 `ctx.effect` 生命周期内。证据：`$AI/dsh-client-ui-renderer/lib/client.js:1372-1428`。

### 2.3 body 组件 props 从哪来

body 的 props = **owner props（本座位无）** + **inject face**（类型注册的 `inject` 返回值，`hooks` 自动转 `useXxx`）+ **scope standard props**（session 作用域注入的标准 props：`sessionId`、`useSessions`、`useWorkspaces`、`useSessionStatus`、`useChat`、`useConversation`、`useInput`、`inputActions`、`useSession`、`useProjection`、`useAccess`、`useTrajectory`…；`locale` 则注入 `t`）。证据：`dsh-cordis-client-runner/lib/client.js:2150-2180`（`SessionStandardProps`/`PropsRuntime`）、`5748-5840`（standardProps 列表）。

真实使用（files 的 `FilesBody`，`$AI/dsh-client-ui-sidebar-files/lib/client.js:595-605`）：

```js
function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions, start, refresh, setAutoRefresh, toggle, t, renderSlot }) {
  const { tab } = useTabInfo();
  ...
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
```

terminal 的 body 是 lazy 包装，`inject: (sessionId) => ({...})`（`client.js:455-483`）；browser 的 body `inject: (sessionId, actions) => {...}`（`client.js:1614-1626`）；documentpreview 的 body `inject: (sessionId, actions) => ({...}, hooks: {...})`（`client.js:7235-7240`）。**结论**：`inject` 参数固定为 `(sessionId)` 或 `(sessionId, actions)`（后者仅当同时声明了 `store`）；返回对象直接摊进 props，`hooks:` 子对象变成 `useXxx` props。

### 2.4 `useTabInfo()`：是 slot 注入的 hook，不是 props

- sidebar-right 在声明座位时把 `tabInfo` 作为 **hook context** 注入：`inject: { hooks: { tabInfo: tabInfoFactory } }`（`client.js:4930-4938`）。因此 body 从**props 里解构 `useTabInfo`，再调用它**，而不是通过参数直接拿到 `{tab}`。
- 实现：`tabInfoFactory`（`client.js:4739-4776`），返回结构：

| 返回字段 | 内容 | 证据 |
|---|---|---|
| `sidebar.expanded` | 侧栏是否展开 | `client.js:4752-4755` |
| `sidebar.fullscreen` | 是否全屏面板 | 同上 |
| `panel.id` | 所在 pane id（docked） | `client.js:4756` |
| `tab` | `TabRecord` 展开：`id`、`kind`、`contentId`、`title`、`paneId` 等记录字段 + `visible`、`navigation`、`signal`、`actions`、`refreshShortcut` | `client.js:4756-4774` |
| `tab.visible` | body 可见性：`active && (float || expanded && (title || pane.activeTabId === tabId))`；**title seat 传 `title: true`，因此 title 组件里 `tab.visible` 语义不同** | `client.js:4758-4767` |
| `tab.navigation` | `{ address, params, revision }` 的 observable snapshot（`useTabNavigation` 绑定）；`params` 来自 `openTab/openResource` 的 `options.params`，JSON 形状、运行时不校验 | `client.js:2167-2170,410-417` README:93 |
| `tab.signal` | `AbortSignal`：只在 tab 被**真正移除/插件卸载**时 abort；收起侧栏、切 session 不 abort | `client.js:1857-1905`；README:104 |
| `tab.actions` | 绑定到该 tab 所属 session 的 `{ openResource, openTab, close, bindCommands }` | `client.js:1857-1905` |
| `tab.title` | 打开时捕获的标题文本 | `client.js:4756` |

- title seat 同样拿到 `useTabInfo`（`hookContext.title = true`），可据此实现「动态标题」：从自己的 store/observable 读最近会话名（见 §5.4）。

**未注册 title 的 fallback**（`client.js:1322-1330`）：

```js
function titlesFor(panel) {
  return (tab) => jsx(TabSlot, { ...panel, tab, seat: "sidebar.right.pane.tab.title", fallback: tab.title }, tab.id);
}
```

### 2.5 body 如何得知当前 session / cwd / workspace

| 需要 | 来源 | 证据 |
|---|---|---|
| 该 tab 所在 session id | 标准 prop **`sessionId`**（`rightbar.session` 作用域注入）+ `useTabInfo().tab` | files `client.js:595,605`；catalog standardProps |
| session 元数据（cwd/title/…） | `useSessions(sel)` 的 `sel.list` 快照：`{ ids, byId: Record<SessionId, SessionSummary>, phase, projectionsBySession }`；files 直接 `sessions.byId[sessionId]?.cwd` | `dsh-cordis-client-runner/lib/client.js:2169-2177,1266-1290`；files:605 |
| workspace | `useWorkspaces(sel)`：`WorkspaceView { workspaceId, path, title, sessionIds, createdAt, updatedAt }`（`workspaces.list` 快照 `items[]`） | TYPE_API `WorkspaceView`；quickchat 现有 `projectContextForSession` 即用 `workspaces.items[].sessionIds` 反查（`client/client.js:523-537`） |
| 资源读取 | `ctx.resources.pin` / 标准 `useResource`（本方案不需要） | catalog standardProps |

> ⚠️ **不要**在 body 里调用 quickchat 现有的 `currentSessionContext()`（它读全局 `sessions.list.current`）。body 的 session 可能是后台 session，必须用 props 的 `sessionId`。

### 2.6 最小可行两段式注册代码

> 以下为**示意代码**（省略了实际 bundle 的 lazy-CJS 包装与 `module.exports` 形式；最终形态沿用现有 `window.__ModuleLoader__.load({ id, factory })` + 返回 plugin 对象）。`zh/en` 为已有字典。
> 另：官方包的**运行时** cordis inject 写法可直接对照 —— `browser`：`["slots","locale","sidebarRight","sidebarRightTabs"]`（`$AI/dsh-client-ui-sidebar-browser/lib/client.js:exp.inject`）；`documentpreview`：`["slots","locale","sidebarRightTabs","remote","remote.workspaceFiles","configForms","resources"]`。

#### A. 页面型（quickchat 采用这种；以 terminal 为模板精简约）

`$AI/dsh-client-ui-sidebar-terminal/lib/client.js:350-358,438-489`：

```js
// ---- 服务清单（cordis plugin.inject，第三方按需取舍）----
const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs", "shortcuts"];

function apply(ctx) {
  const NS = "dsh-quickchat";
  const ID = "dsh-quickchat";
  const KIND = "quickchat";
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-quickchat: copy");

  // 阶段 1：类型
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    keepMounted: true,
    title: () => t("quickChat"),
    guide: [{
      id: "panel",
      commandId: "quickchat.open",     // 与 shortcuts 的 id 联动显示键帽
      order: 40,
      title: () => t("guideTitle"),
      description: () => t("guideDescription"),
    }],
  }), "dsh-quickchat: tab type");

  // 阶段 2：body（key = definition.id）
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: ID,
    locale: NS,                        // → 注入 t
    // store: createQuickChatStore(),  // 需要 per-session store 时再加
    // inject: (sessionId, actions) => ({ ... }), // → 摊进 props
  }, QuickChatTabBody)), "dsh-quickchat: tab body");

  // 阶段 2b：动态标题（可选，Phase 2）
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: ID,
    locale: NS,
  }, QuickChatTabTitle)), "dsh-quickchat: tab title");
}

export { apply, inject };
```

#### B. 资源型（仅作对照；quickchat 不需要）

`$AI/dsh-client-ui-sidebar-files/lib/client.js:15-35,996-1021`：

```js
const FILES_KIND = "files";
const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";

function filesDefinition(t) {
  return {
    id: FILES_ID,
    kind: FILES_KIND,
    priority: "builtin",
    title: () => t("type.label"),
    guide: [{ id: "workspace", commandId: "workspace.files", order: 10,
              title: () => t("guide.title"), description: () => t("guide.description"),
              icon: GuideArtworkFiles }],
  };
}
// body 里打开文件：
tab.actions.openResource(fileAddressFor(sessionId, state.root, path));
// 或对外：
ctx.sidebarRight.openResource(address, { params: { line: 3 } });
```

#### C. 资源型带 patterns/canOpen 的对照（plan）

`$AI/dsh-client-ui-plan/lib/client.js:630-639`：

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: "@deepseek-ai/dsh-client-ui-plan",
  kind: "plan",
  patterns: ["dsh-resource://plan/**", "dsh-resource://plan-review/**"],
  priority: "builtin",
  canOpen: (address) => parsePlanAddress(address) !== undefined || isReviewPreviewAddress(address),
  title: () => t("preview.title"),
}), "ui-plan: sidebar type");
```

### 2.7 guide / 菜单 的可选扩展

- **自定义 guide 卡片**（不用默认图标+标题按钮时）：注册 keyed `sidebar.right.tab.guide.entry`，`key = definition.id`；owner props `{ entryId, kind, title, description }` + `useTabInfo`。范例 terminal `client.js:463-474`；contract `runner:6205-6246`。
- **tab 右键菜单**：`sidebar.right.tab.menu.item`（list，session 作用域），注册 `{ name, id, order, label }`，组件 owner props `{ tab, dismiss }`；**执行动作后必须调用 `dismiss()`**。目前 0.2.1-rc.2 无官方注册者，仅 contract 存在（`runner:6248-6290`）。适合 Phase 2 加「在浮窗中打开 / 关闭」等。
- **guide 默认页规则**：默认页由 **guide entry 数量**决定——恰好 1 个 entry 时展开侧栏直接打开该类型；0 个或多个则打开 guide 页（`client.js:585-596`；README:119）。当前官方 files/browser/terminal 共 3 个 entry（若 composition 启用 `experimental-session-inspector` 则更多），加 quickchat 后仍是 guide 默认页；但**若某 composition 只启用 sidebar-right + quickchat**，展开侧栏会直接打开 quickchat 页。

---

## 3. 打开、聚焦与第三方入口（Q2）

### 3.1 `ctx.sidebarRight` 公开面（`client.js:2063-2490`）

| 方法 | 签名 | 行为 | 证据 |
|---|---|---|---|
| `openTab` | `openTab(kind: string, options?): void` | 页面型打开/聚焦；未注册 kind 抛错；**自动展开侧栏**；页面型在目标 pane 内去重（focus 已有） | `2119-2155,2185-2225`；README:93 |
| `openResource` | `openResource(address: string, options?): void` | 资源型；address 必须 `dsh-resource://` 开头否则抛错；由注册表 claim（可按 `options.kind` 指定类型） | `2119-2127,2179-2183` |
| `openTabFromTarget` | `openTabFromTarget(kind, target): void` | 用快捷键/命令捕获的 pane target 打开，继承 guide 替换与 float 规则；`target` 来自 `commandTarget()`/`focusedTarget()`；target 过期则 no-op | `2272-2320` |
| `close` | `close(tabId)` | 关闭 on-screen session 的 tab（唯一 guide 除外） | `2226-2232` |
| `active` / `isExpanded` / `toggleExpanded` | — | 活动 tab / 展开态 / 切换展开 | `2237-2260` |
| `focus` / `split` / `float` / `dock` / `toggleFullscreen` | — | 程序化布局操作（等价用户手势，记 undo） | `2262-2386` |
| `commandTarget(element?)` / `focusedTarget(element?)` | — | 解析当前 pane/tab target，供快捷键 resolve | `2272-2302` |
| `openTabs` | `ObservableSnapshot<{ sessionId, tabId, kind, contentId }[]>` | 所有 open tab 元数据（含后台/已保存），**本方案做按钮状态、去重、保留资源用** | `1921-1975,2026,2067` |
| `mounted` | `ObservableSnapshot<SessionId \| undefined>` | on-screen session；**undefined 时 `openTab` 会抛错**（决策"是否可开 tab"用） | `2479-2488` |
| `tabsIn(sessionId)` | — | 某 session 已提交的 tab 记录（provider 恢复用） | `2095-2105` |
| `registerCloseHandler` | `registerCloseHandler(kind, handler)` | 关闭前同步清理；抛错保留 tab；每 kind 只能注册一次 | `2079-2093`；README:108 |
| `tabDomain` | — | 内部 Tab domain（`occurrence` 等；第三方一般不用） | `2108-2117` |

### 3.2 `openTab` / `openResource` 的 options 明细

源码 `place()`（`client.js:2189-2225`）+ README:93-95：

| option | 类型 | 语义 |
|---|---|---|
| `paneId` | `string?` | 目标 pane；缺省 active docked pane |
| `replaceTab` | `string?` | 替换指定 tab（关闭它）并在其 pane/slot 打开；**优先于 `preferNewPane`** |
| `revealIfOpened` | `boolean?` | 资源型：同 `(kind, contentId)` 已存在时是否 focus（默认 focus）；`false` 则强制新开。**页面型 tab 永远在目标 pane 内去重，与此选项无关** |
| `preferNewPane` | `boolean?` | 先尝试 split（受两 pane 上限 + 宽度规则），失败回退原 pane；`replaceTab` 存在时禁用 |
| `params` | `JSON value?` | 打开参数，写入 Tab domain navigation → body `useTabInfo().tab.navigation.params`，`revision` 自增；运行时不校验形状 |
| `kind` | `string?` | **仅 `openResource`**：指定用哪个类型 claim（跳过 patterns，保留 `canOpen`） |

行为要点【确证】：
- 打开即展开侧栏（"content the user cannot see is not opened"）。
- 页面型地址由包内部合成 `sidebar://<kind>`（`multiple` 时 `sidebar://<kind>/<uuid>`），**调用方永远不自己拼**（`client.js:599-608`；README:93）。
- `openTab` 在 `mounted === undefined`（无 on-screen session）或该 session store 尚未 mint 时抛错（`client.js:2479-2488`）——因此**调用前先判断 `ctx.sidebarRight.mounted.getSnapshot()`**。
- `openTab` 会把「活动 pane」作为目标：若 quickchat 已在**另一个 pane**，再次 `openTab` 可能在活动 pane 再开一个；去重后依然需要 `openTabs` + `focus(tabId)` 来聚焦跨 pane 的已有实例（Phase 1 可接受，Phase 2 做）。

### 3.3 第三方触发入口：可用座位与真实写法

#### 3.3.1 座位对照表（0.2.1-rc.2 contract）

| 座位 | kind | scope | 现状 / 占用 | 第三方可用性 | 证据 |
|---|---|---|---|---|---|
| `conversation.input.right` | list | session | 当前 quickchat 触发按钮在此（`order:95`）；**仅当 `sessionId !== undefined` 才渲染** | ✅ **推荐保留** | quickchat `client.js:1107-1112`；`dsh-client-ui-conversation/lib/client.js:19080` |
| `conversation.session.header.actions` | list | session | 官方 agent-preset / jobs / subagent 占用 | ✅ 可用（标题旁 actions） | catalog `runner:3861-3922` |
| `conversation.session.header.utilities` | list | session | 官方 open-in-app / schedule / session-log 占用 | ✅ 可用（右侧 utilities） | catalog `runner:3999-4070` |
| `conversation.session.header.corner` | **single** | session | **被右侧栏 `ExpandButton` 占用**；replaceRisk = `shadows-shipped-ui` | ❌ **不要用**：注册会替换官方「展开右侧栏」唯一入口 | catalog `runner:3923-3998`；sidebar-right `client.js:4962-4970` |
| `conversation.header.leading` | single | root | 未占用（`occupants: []`）；"available without a Session" | ⚠️ 技术上可用，但属全局导航座位，第三方占用可能撞官方未来规划 | catalog `runner:3052-3117` |
| `conversation.hero.options` | list | session | hero 的 New Session 行右侧；**有 session 的 hero 才渲染** | ✅ 可做 hero 第二入口（Phase 2） | catalog `runner:3146-3190`；ui-conversation `client.js:17810-17820` |
| `shell.overlay` | list | root | 现有 quickchat 浮窗在此 | ✅ 保留作为降级（Phase 1） | catalog `runner:5433-5505`；quickchat `client.js:1114-1119` |
| `sidebar.right.tab.guide.entry` | keyed | session | 自定义 guide 卡片 | ✅ Phase 2 | catalog `runner:6205-6246` |
| `sidebar.right.tab.menu.item` | list | session | tab 右键菜单追加 | ✅ Phase 2 | catalog `runner:6248-6290` |

#### 3.3.2 header 按钮的可用写法（回答 Lead 第 4 点）

要在 conversation header 加第三方按钮，**不要碰 `.corner`**（single，且是右侧栏展开开关）；用 list 型座位：

```js
// conversation.session.header.utilities（或 .actions），scope = session
ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
  name: "conversation.session.header.utilities",
  id: "quickchat.open",
  order: 120,
  label: () => t("open"),     // 可选：投影到导航/工具提示
  locale: NS,
}, QuickChatHeaderButton));
```

组件 props 会带 `sessionId`、`useSessions` 等标准 props 与注入的 `t`（catalog standardProps 列表），所以按钮可直接：

```js
function QuickChatHeaderButton({ sessionId, t }) {
  const onClick = () => {
    const sidebar = pluginCtx.sidebarRight;               // 或 ctx 闭包
    const mounted = sidebar?.mounted.getSnapshot();
    if (sidebar && mounted !== undefined) sidebar.openTab("quickchat");
    else openFallbackOverlay();                            // 降级
  };
  return /* Button + Tooltip（ui-primitives） */;
}
```

> 注意：`.utilities` / `.actions` 都只在有 session 的 conversation header 出现；sessionless hero 没有这些座位。若要覆盖「完全没有 session」的入口，只能用 root 座位（`conversation.header.leading` 或 `shell.overlay` 里的自定义 launcher）。本方案 Phase 1 **不追求** sessionless 入口，保留浮窗降级即可。

#### 3.3.3 快捷键注册（`ctx.shortcuts.register`）

真实写法（files `client.js:938-996`，terminal `388-433` 同构）：

```js
ctx.inject(["shortcuts"], (ctx) => {
  ctx.effect(() => ctx.shortcuts.register({
    id: "quickchat.open",
    label: () => t("shortcut.open"),
    aliases: ["quick chat", "quickchat"],
    defaults: {
      "desktop:macos":   { code: "KeyQ", modifiers: ["primary", "shift"] },
      "desktop:windows": { code: "KeyQ", modifiers: ["primary", "shift"] },
      "desktop:linux":   { code: "KeyQ", modifiers: ["primary", "shift"] },
      // web 可省略（未声明的 profile = 不绑定）
    },
    regions: ["page", "editable", "terminal"],
    modals: [],
    resolve: ({ target: element }) => {
      const target = ctx.sidebarRight.commandTarget(element);
      if (target === undefined) return { status: "blocked", reason: t("shortcut.noSession") };
      return { status: "handled", run: () => ctx.sidebarRight.openTabFromTarget("quickchat", target) };
    },
  }), "dsh-quickchat: shortcut");
});
```

契约要点：`id` 唯一；defaults 按 6 个 profile 声明（缺省=不绑定）；`primary` 展开为平台主修饰键；重复 id / 冲突组合会抛错；`resolve` 同步返回 `handled`（带 `run`）或 `blocked`（带原因）；命令注册/卸载会失效打开中的快捷键编辑草稿。— `$AI/dsh-client-shortcuts/README.md:37-55`；`regions` 合法值见官方用法 `page`/`editable`/`terminal`。

**与 guide 的联动**：guide entry 的 `commandId` 必须等于 shortcut 的 `id`，guide 卡片才会在右侧显示键帽（`sidebar-right/client.js:524-545`；terminal `444-450` 的 `new` 对应 `terminal.new`）。

#### 3.3.4 tab strip 的 `+` 行为

- strip 的 add 控件**只会打开 guide**：`intentsFor.addTab` → `openTab(GUIDE_KIND, { paneId, revealIfOpened: false })`，且仅当该 pane 还没有 guide tab 时绘制（`client.js:1214-1222`；README:50,121）。
- **第三方无法把自定义按钮加进 tab strip**（没有对应 slot）。第三方 tab 只能通过：guide 卡片、快捷键、自己的入口按钮、tab 右键菜单（`sidebar.right.tab.menu.item`）打开。
- dockkit 的 split / float / dock / 关闭等操作由 kit chrome 与侧栏自身提供（`intentsFor` 全套，`client.js:1204-1262`），第三方 tab 自动获得，无需实现。

---

## 4. 第三方开放性与装配要求（Q3）

### 4.1 是否对第三方开放？—— 开放，无 allowlist【确证】

- 注册器 `SidebarRightTabRegistry.register` 只做 3 类校验：guide 内 id 唯一、`id` 全局唯一、同 kind 共存规则；**没有任何包名/白名单/权限校验**（`client.js:4465-4535`）。
- README 明确："the shipped guide type goes through exactly the same public path a type from another package does (`ui-sidebar-documentpreview` is the live proof)"（README:81-83）；"a type from outside the product, the highest, and the default when none is named"（README:86）。
- `dsh-client-ui-sidebar-documentpreview` 用公开 API 注册 `patterns/canOpen/title` 类型（`client.js:1076-1088,7209`），不是特例。
- client-module 装载层也没有插件白名单：`dsh.client` 声明只校验 `platform`(string)、`inject`/`external`(string[])、`immediately`(boolean)（`dsh-client-modules/lib/index.js:57-77`）。第三方包只要作为 profile 的一行被 Loader 启用，就会像官方包一样被 `/plugins` 服务装载（`dsh-client-modules/README.md` "Declaring a client plugin"）。
- 你现有的 quickchat 已经在用同一条链路（`window.__ModuleLoader__.load({ id, factory })` lazy-CJS bundle，`dsh-client-modules/README.md` "Lazy-CJS model"）。

**约束只有**：① `sidebarRightTabs` / `slots` 服务必须存在（见 4.3 装配）；② id/kind 冲突规则；③ 类型体通过 keyed slot 注册；④ 布局记录里残留的 kind 在类型卸载后渲染 fallback 提示而不是崩溃（`client.js:1308-1320`）。

### 4.2 `package.json` 的 `dsh.client.inject` 需要加什么

⚠️ **两个 inject 不是一回事，别混淆**：
- `package.json → dsh.client.inject`：**模块装载图依赖**（包名数组）。host 把它并进 `__DSH_BOOT__` 的行依赖，浏览器装载时先 `arriveDependency` 依赖行再装载本行（`dsh-client-modules/lib/index.js:414-437`；`lib/client.js:776-796`）——决定「谁先到达浏览器」。
- `client.js` 导出的 plugin 的 `inject`：**cordis 运行时服务依赖**（服务名字符串数组）——决定「插件等哪些服务就绪才 apply」。两者官方包都写，quickchat 也要两层都改。

`dsh.client.inject` 官方 sidebar 插件都把 `@deepseek-ai/dsh-client-ui-sidebar-right` 写进去（files/terminal/browser/documentpreview 的 package.json），第三方照抄：

```jsonc
// /Users/gc/dsh-plugin-quickchat/package.json  →  dsh.client.inject
"inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-client-ui-settings",        // 设置迁移后可能不再需要
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-ui-sidebar-right",   // ★ 新增：右侧栏 tab 注册表/服务
  "@deepseek-ai/dsh-client-shortcuts",          // ★ 新增：快捷键（若加）
  "@deepseek-ai/dsh-client-ui-conversation"     // ★ 可选：header 按钮座位（若 Phase 2 加）
]
```

说明：
- 不需要在 `dsh.client.external` 里声明 react / cordis / ui-primitives / ui-slots / dsh-client-store —— 这些在 shell 的**平台模块种表**里：`{ react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", zod, "@tanstack/react-virtual", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit" }`（`$AI/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`，函数 `SZ(){return{...}}`）。因此 quickchat 想复用 `@deepseek-ai/dsh-client-store` 的 `createStore/createSnapshotStore` 或 ui-primitives 组件，直接 `require()` 即可，**不需要改 external**。
- sidebar-right 的 `dsh.client.inject` 里已列出它依赖的会话/布局/资源包（`$AI/dsh-client-ui-sidebar-right/package.json`），第三方无须重复列出它的下游。

### 4.3 client.js 里 `plugin.inject` 应声明哪些服务

服务名以 `ctx.reflect.provide` 为准【确证】：sidebar-right 在 apply 中提供 `sidebarRightTabs` 与 `sidebarRight`（`client.js:4848-4849`），它们**不在**官方 SERVICE_API catalog 里（catalog 只收 `ctx.provide` 的 Service），但官方插件一律以字符串注入数组声明，且实测可用：
- files：`["slots","locale","sidebarRightTabs","sidebarRight","remote","remote.workspaceFiles"]`（`$AI/dsh-client-ui-sidebar-files/lib/client.js:934-942`；它的快捷键用可选注入 `ctx.inject(["shortcuts"], cb)`，`client.js:947`）
- terminal：`["slots","locale","sidebarRight","sidebarRightTabs","webTerminals","theme","shortcuts"]`
- browser：`["slots","locale","sidebarRight","sidebarRightTabs"]`
- documentpreview：`["slots","locale","sidebarRightTabs","remote","remote.workspaceFiles","configForms","resources"]`

说明 reflect 提供物同样可被 cordis inject 解析。

quickchat 建议的运行时 inject（含移除旧服务）：

```js
const inject = [
  "slots",             // 已有
  "sessions",          // 已有
  "workspaces",        // 已有
  "locale",            // 已有
  "remote", "remote.llm", "remote.session",  // 已有
  "sidebarRight",      // ★ 新增：ctx.sidebarRight 控制器
  "sidebarRightTabs",  // ★ 新增：tab 类型注册表
  "shortcuts",         // ★ 新增（若注册快捷键；也可用 ctx.inject(["shortcuts"], cb) 可选注入）
  // "settingsScope",  // ★ 删除：0.2.1-rc.2 不存在（见 §5.7）
];
```

**硬依赖 vs 可选注入的取舍**：
- 官方包全部硬依赖（直接写进 `inject`）。硬依赖的代价：如果用户的 composition 没有启用 sidebar-right，quickchat 的 client 插件会一直 pending。boot kernel 在所有 entry 未激活时会抛 `web boot: N entries did not activate`（`$AI/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`，`function bZ`），**整页启动失败**（Lead 实测 settingsScope 即如此）。
- 更稳的降级写法（官方 browser 包对 `workspaces` 用的就是这个模式，`dsh-client-ui-sidebar-browser/lib/client.js:1629-1631`）：

```js
// 顶层 inject 不含 sidebarRight/sidebarRightTabs；apply 内可选注入
ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
  scope.effect(() => scope.sidebarRightTabs.register({ /* ... */ }), "dsh-quickchat: tab type");
  scope.effect(() => scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ /* ... */ }, QuickChatTabBody)), "dsh-quickchat: tab body");
  // 标记 tabIntegrationAvailable = true，供触发按钮分支
});
```

> 推荐 Phase 1 用**可选注入**：没有右侧栏时插件照常激活、浮窗降级可用；同时把 sidebarRight/sidebarRightTabs 放进 `package.json dsh.client.inject` 保证装载顺序。若 Lead 判断目标用户必然带官方右侧栏，也可用硬依赖简化（但 P0 教训是：**先确认服务真实存在**）。

### 4.4 加载顺序

1. host 端 `orderByModuleGraph` 按 `dsh.client.inject`/`external` 拓扑排序组合 boot 图（`dsh-client-modules/lib/index.js:414-437`）。
2. 浏览器端 `arriveGraphRow` 先把 `inject` 行的 bundle 注册为 factory，再注册自己（`lib/client.js:776-796`）。
3. Loader 按图顺序创建 entry，cordis 的 inject 等待负责最终生效顺序；所有 entry 都 active 才 mount（`dsh-web-frontend` boot kernel）。

结论：把 `@deepseek-ai/dsh-client-ui-sidebar-right` 加进 `dsh.client.inject` 即可获得确定性顺序，无需额外 priority。

### 4.5 kind / id 命名注意事项

- `id` 用**包名**（官方惯例 `@deepseek-ai/dsh-client-ui-sidebar-files`）；quickchat 包名 `dsh-quickchat`，建议 `id: "dsh-quickchat"`。`id` 全局唯一，重复即 throw。
- `kind` 小写、短、语义化；具体值官方为 `files`/`terminal`/`browser`/`plan`/`subagentchat`/`changes-review`/`deliverables`/`schedule-task`/`guide`。建议 `"quickchat"`；避免 `guide`。
- 未来若官方也注册 `quickchat` kind：extension + builtin 可共存，extension（我们）in-force；两个 extension 同 kind 才报错。
- `guide` entry 的 `id` 只需在**本 provider 内**唯一（注册器按 definition 分组检查，`client.js:4467-4468`）。
- `title` 会在打开时被快照进布局记录；`multiple: true` 时 `title(address)` 收到带 uuid 的 address，函数需容忍任意 address。

### 4.6 `keepMounted` / `multiple` 对 quickchat 的取舍

| 维度 | `keepMounted: true`（推荐 Phase 1） | `keepMounted: false`（默认） |
|---|---|---|
| 切换 tab / 收起侧栏 / 切 session | body 保留：流式输出、草稿、滚动位置不丢 | body 卸载：进行中的 fetch 被组件 cleanup abort，草稿丢失 |
| 内存 | 访问过的 quickchat body 常驻（还有后台 session 的已初始化 body，README:61） | 更省 |
| 多实例 | **必须** per-body 隔离状态（见 §5.2） | 单实例场景简单 |
| 证据 | `client.js:1253-1266`；README:106 | 同左 |

| 维度 | `multiple: false`（推荐） | `multiple: true` |
|---|---|---|
| 实例 | 每 pane 一个 quickchat，`contentId = sidebar://quickchat`；再次 open 聚焦 | 每次 open 新建独立实例 `sidebar://quickchat/<uuid>` |
| 适用 | quickchat 是「项目级最近会话面板」，一个面板足够；与 host 项目级数据模型一致 | 「一个 chat 一个 tab」，需要 per-tab chat 绑定（用 navigation.params 传 chatId），标题需按实例动态 |
| 风险 | 无 | 布局记录膨胀、标题/去重复杂、与「最近会话列表」交互设计冲突 |
| 证据 | `client.js:2185-2188`；README:117 | 同左 |

结论：**Phase 1：`keepMounted: true` + `multiple: false`**。

---

## 5. QuickChat 集成方案（Q4）

### 5.1 推荐注册参数

```js
const ID = "dsh-quickchat";
const KIND = "quickchat";
const NS = "dsh-quickchat";   // 现有 locale namespace

const definition = {
  id: ID,
  kind: KIND,
  // patterns 省略 → 页面型
  // priority 省略 → 默认 "extension"（最高 band）
  title: () => t("quickChat"),          // 打开时捕获；Phase 2 用 title seat 做动态标题
  keepMounted: true,
  // multiple 省略 → false
  guide: [{
    id: "panel",
    commandId: "quickchat.open",        // 与 shortcut id 一致
    order: 40,                          // files=10, terminal=20, browser=30 → 40 在其后
    title: () => t("guideTitle"),       // 新增 i18n key
    description: () => t("guideDescription"),
    // icon 可省略（默认占位方块）；若加，传入 React 组件（{size} prop）
  }],
};
```

`openTab` 调用：`ctx.sidebarRight.openTab("quickchat")`（无 address、无 params）。

### 5.2 body 组件改造：从 fixed 浮窗拆出可嵌入布局

**现状**（`/Users/gc/dsh-plugin-quickchat/client/client.js`）：
- `QuickChatPanel`（~1060-1096）输出 `position: fixed` 的 shell + `ResizeHandle`，高度/位置由 `useQuickChatPanelGeometry` 追踪 `[data-conversation-scroll]` 计算；全局单例 `panelStore`（507）、`api`（509）、`pluginCtx`（508）、`aborters`（512）。
- 子组件：`Trigger`（705）、`Header`（718）、`RecentChats`（756）、`Thread`（780）、`Composer`（798）、`ResizeHandle`（821）、`ConversationRow`。
- 逻辑：`createQuickChatStore`（266）、`projectContextForSession`（523）、`loadProject`（542）、`selectConversation`（597）、创建/重命名/删除、流式发送/停止（~620-704）、`createApiClient`（362）。

**改造原则：所有数据请求逻辑原样复用，只把「单例状态 + fixed 布局」换成「per-body controller + 填满容器的布局」。**

| 现状元素 | tab 版处理 |
|---|---|
| `panelStore` 模块级单例 | ❌ 删除；body 内 `const [controller] = useState(() => createQuickChatController({ sessionId, sessions, workspaces, api }))`，controller 持有 state + subscribe + 所有动作；或注册 `store: createQuickChatSessionStore()` 用 slot 的 `useStore/actions`（per-session store，内部 `byTab[tab.id]` 分桶，参照 files `client.js:595-650`） |
| `currentSessionContext()`（读 `sessions.current`） | ❌ 不用；body 用 props `sessionId` + `projectContextForSession(useSessions 快照, useWorkspaces 快照, sessionId)`（复用现有函数，`client.js:523-537`） |
| `QuickChatPanel` fixed shell / `useQuickChatPanelGeometry` / `ResizeHandle` | ❌ tab 内不适用，删除该路径；body 根节点：`{ height: "100%", minHeight: 0, width: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }`，内部滚动区 `flex: 1; minHeight: 0; overflow: auto` |
| `Header` 的 `−` 收起按钮 | 改为 tab 关闭：`useTabInfo().tab.actions.close()`（或交给 kit 的 chip 关闭按钮，默认就有）；`+` 保留 |
| `Escape` 关闭 / 点击外部关闭 / 背景遮罩 | ❌ 删除（tab 内没有模态语义） |
| `Trigger`（input.right 按钮） | 保留座位，点击行为改为「open/focus tab，失败时降级浮窗」（见 5.5） |
| `settings.plugin.item` 卡片 | Phase 0 先禁用；Phase 2 迁移（见 5.7） |
| `shell.overlay` 浮窗注册 | Phase 1 保留作为降级；Phase 2 可删除或改为「float panel」入口 |
| 配色 / 毛玻璃 / 圆角 | Phase 1 先保留可用样式（阅读区跟随 --dsw-alias 变量）；Phase 2 改用 ui-primitives + 主题 token，与右侧栏视觉一致 |

**body 骨架（示意）**：

```js
function QuickChatTabBody({ sessionId, useSessions, useWorkspaces, t, useTabInfo }) {
  const { tab } = useTabInfo();
  const sessionsSnapshot = useSessions((s) => s);
  const workspacesSnapshot = useWorkspaces((s) => s);
  const ctxInfo = projectContextForSession(sessionsSnapshot, workspacesSnapshot, sessionId);
  const [controller] = useState(() => createQuickChatController({ sessionId }));
  // controller: loadProject(ctxInfo) on session/cwd change; subscribe via useSyncExternalStore
  return h("div", { style: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" } },
    h(Header, { ... }),
    h(Thread, { ... }),
    h(Composer, { ... }),
    h(RecentChats, { ... }));
}
```

### 5.3 project-scoped 状态 vs per-session 侧栏：冲突与处理

| 事实 | 证据 | 后果 / 处理 |
|---|---|---|
| 右侧栏布局按 **session** 存：`dsh.sidebar-right.v1.<sessionId>` | `dsh-client-ui-sidebar-right/README.md:74` | 同一 project 的两个 session 各自有 quickchat tab；切 session 看到的是各自布局 |
| quickchat 数据按 **project** 存：host 规范化为 `$DSH_HOME/quickchat/projects/<sha256>/` | 仓库 `README.md`「项目域」；`lib/quickchat-service.js` | 同 project 两个 session 的 tab 读到同一份 conversations/index（共享聊天列表）——语义正确，无需改 host |
| 侧栏 root 会渲染「选中 session + 已初始化 keepMounted body 的后台 session」 | sidebar-right `README.md:61` | **同 project 的两个 session 的 quickchat body 可能同时挂载**：必须 per-body 状态（不能共享 `panelStore`） |
| project 根判定优先用 `cwd`/`projectRoot`，缺省 `default-workspace` | quickchat `client/client.js:523-537,542-559`；README「项目域」 | body 里用**自己的 sessionId** 解析 project；不要用 `sessions.current` |
| 草稿/当前会话/流式属于「该 tab 的 UI 状态」，不是 project 数据 | 现状 `panelStore` 字段（`createQuickChatStore` 266-295） | 留在 per-body controller；如需刷新后保留，可用 slot `store` 的 `persist` 或 host 侧扩展（Phase 2 再议） |

**是否共享状态？** Phase 1：**不共享**。同 project 多 session 各自独立「当前会话选择/草稿/流式」，聊天数据共享即可。若产品要求「同 project 下所有 quickchat tab 同步当前会话」，Phase 2 再引入 project 级 observable（模块级 Map<projectKey, store>，但 body 卸载不影响），成本高、收益低，暂不做。

### 5.4 标题（tab chip 文本）

- Phase 1：静态本地化标题 `title: () => t("quickChat")`（如「临时对话」）。打开时快照，语言切换后 chip 不重译（README:146）。
- Phase 2：注册 `sidebar.right.pane.tab.title`（key = ID），组件里 `useTabInfo()` + 从 per-session store / 注入 observable 读「当前（或最近）会话标题」，显示 `Title · 项目名`；无会话显示 `t("quickChat")`。参考 terminal 的 `TerminalTitle`（`dsh-client-ui-sidebar-terminal/lib/client.js:224-282`）与 browser 的 `BrowserTitle`。
- 注意 title 组件的 `tab.visible` 语义（`title: true` 时 `visible = active && …`），不要拿它当 body 可见性。

### 5.5 打开与关闭行为 / 持久化

**打开**（Trigger 改造）：

```js
function openQuickChat() {
  const sidebar = pluginCtx?.sidebarRight;
  const mounted = sidebar?.mounted?.getSnapshot();
  if (sidebar && mounted !== undefined && tabIntegrationAvailable) {
    // 已有则聚焦（含跨 pane 情况），否则打开
    const existing = sidebar.openTabs.getSnapshot()
      .find((row) => row.sessionId === mounted && row.kind === "quickchat");
    if (existing) {
      // 先尝试 openTab 去重聚焦；跨 pane 时用 focus
      sidebar.openTab("quickchat");
      sidebar.focus(existing.tabId);
    } else sidebar.openTab("quickchat");
    return true;
  }
  openFallbackOverlay();   // 无 session / 无右侧栏 / 插件 pending
  return false;
}
```

> `mounted`/`openTabs` 都是 observable，按钮的 pressed/active 状态可在 Phase 2 用 `useSyncExternalStore` 订阅 `openTabs` 实现（按 sessionId+kind 过滤）。

**关闭**：
- 用户点 chip 的关闭按钮 / 快捷键 `page.close` / 右键菜单 → kit/sidebar-right 处理；唯一 docked tab 关闭时侧栏一起收起（README:72）。
- 若在流式输出中关闭：优先注册 `ctx.effect(() => ctx.sidebarRight.registerCloseHandler("quickchat", (sessionId, tab) => { abortStreamForTab(tab.id) }), ...)`（`client.js:2079-2093`）做同步清理；tab 被移除时 `tab.signal` 也会 abort（`client.js:1778-1810`），body cleanup 里 abort fetch 即可。
- keepMounted：切 tab / 收起侧栏**不会**卸载 body、不 abort（README:106）；只有关闭 tab 或插件卸载才 abort。
- 插件被停用但布局里还留着 quickchat tab：body 显示 fallback「这类内容还没有可用的查看方式。」（`client.js:1308-1320` 的 `tab.unavailable`），不崩溃。

**持久化**：
- 侧栏布局（tab 记录、pane、选中、宽度、presentation）由 sidebar-right 自动写 localStorage（README:74）；quickchat 聊天数据仍在 host 磁盘（`$DSH_HOME/quickchat/projects/...`）。
- 刷新后：布局先恢复，body 后挂载；body 用 `sessionId` 重新解析 project → `loadProject`。**不要**在打开 tab 时把 chatId/草稿塞进布局（`params` 只用于导航参数，不持久化，README:74 "Navigation parameters ... are not layout state"）。
- 需要「刷新后恢复当前会话」：Phase 2 用 slot `store` 的 `persist`（StoreSpec.persist，按 scope 存）或 host 扩展。

### 5.6 i18n

- 现状已可复用：`client/client.js:1096-1105` 用 `ctx.locale.register(NS, dictionaries)`（`{ zh: {...}, en: {...} }` 形状），与官方 `ctx.locale.register(ns, { zh, en })` 完全一致（`$AI/dsh-client-locale/README.md:44-48`）。
- tab 侧新增 key：`quickChat`（tab 标题）、`guideTitle`、`guideDescription`、`shortcut.open`、`shortcut.noSession` 等；`ctx.locale.bind(NS)` 得到的 `t` 每次调用都取当前语言（README:"A dictionary registered after the UI is already mounted is picked up without a remount"）。
- slot 注册时给 `locale: NS` → body/标题组件 props 里直接有 `t`；body 现有组件都是显式传 `t`，两种都可。
- guide entry 的 `title()/description()` 是 thunk，每次渲染重取语言；tab chip 的 `title()` 只在打开时取一次（快照）。Phase 2 通过 title seat 解决语言切换的 chip 重译。
- `guide.entry.id` 只需 provider 内唯一；`commandId` 不参与翻译。

### 5.7 设置卡片：旧 API 已消失（P0 + Phase 2）

**现状（0.1.0）**【实测 + 确证】：
- client bundle `plugin.inject` 含 `'settingsScope'`（`client/client.js:1148`），但 0.2.1-rc.2 全树 grep 不到该服务名，也 grep 不到 `settings.plugin.item` slot → 整套 client 插件 pending，web boot 报 `… entries did not activate`【实测】。
- host 半 `ctx.settings.installSection(...)`（`lib/index.js:31-42`）在 0.2.1-rc.2 同样不存在（`dsh-settings` 已改为 `Config-derived forms` + `dsh-config-editor` 写 profile patch，见 `$AI/dsh-settings/README.md` 与 `$AI/dsh-config-editor/README.md`）。

**新 API**（0.2.1-rc.2）：
- client 设置卡片座位：`plugins.row.config`，key = `${bundle package name}#${row id}`（`dsh-client-ui-plugin-manager/lib/client.js:24-33` 的 `rowConfigKey`），渲染在插件详情页；owner props `{ view: "summary" | "page", form?: ConfigPageForm }`；`plugins.bundle.config`（key = 包名）用于 bundle 级配置；`plugins.item`（官方分组卡片）。contract 见 `runner:4480-4530,4658-4780,4711-4800`。
- 表单服务：`ctx.configForms`（`dsh-client-ui-settings/lib/client.js:1266-1330`）——`ctx.configForms.get(entryId)`、`ctx.configForms.whileServed([ns], cb)`；官方示例 `dsh-client-ui-settings-agent-loop/lib/client.js:130-160`（在 Host serve 该 namespace 时注册卡片）。

**建议**：
- Phase 0（必须）：从 `plugin.inject` 删除 `'settingsScope'`，并删除/短路 `settings.plugin.item` 注册块（`client/client.js:1121-1134`），让插件先能启动；同步修测试 mock（`tests/client/render-smoke.test.cjs:63,120,248`）。
- Phase 2（可选）：把 provider/model 选择卡迁移到 `plugins.row.config`，key 用 `dsh-quickchat#quickchat`（【推断】需在冒烟实例确认 plugin-manager 对该行的 bundle 归属；验证方法见附录 C），表单可用 `ctx.configForms.get(<entry id>)` 或自定义 fetch（`ownerProps.form` 是可选的，卡片可完全自绘）。
- host 侧配置：保持/改成 cordis profile row config（`apply(ctx, config)` 已经接收 config，`lib/index.js:21`）；若继续用 HTTP 路由保存设置，也可以不依赖 DSH 设置系统。

### 5.8 与 `shell.overlay` 浮窗的关系

| 阶段 | 浮窗（shell.overlay + fixed 面板） | tab |
|---|---|---|
| Phase 1 | **保留**，作为降级路径：`mounted === undefined`（无 session / hero-sessionless / 右侧栏包未启用 / tab 类型注册失败）时触发按钮打开浮窗；tab 可用时不再打开浮窗（避免双份 UI） | 主路径 |
| Phase 2 | 二选一：① 删除浮窗注册与 geometry 代码，只留 tab；② 把「浮出」交给原生能力——`ctx.sidebarRight.float(tabId, rect?)` + tab 菜单项（`sidebar.right.tab.menu.item`），用 kit 的浮动面板替代自绘浮窗 | 主路径 + 可选 float |

> 注意：原生 float 面板与 tab 是同一棵内容树（README:39 "Normal and fullscreen presentations share the same content tree"；浮动面板 tab 可 `dock` 回来），比自绘 fixed 浮窗更一致，Phase 2 推荐用 float 替代浮窗而不是保留两套。

### 5.9 入口设计（汇总）

1. **主入口**：保留 `conversation.input.right` 的触发按钮（`client/client.js:1107-1112`，`aria-label=打开临时对话`），点击改为 open/focus tab；无 session 或无右侧栏时降级打开浮窗。按钮位置/外观不变，用户无感迁移。
2. **guide entry**：`{ id:"panel", commandId:"quickchat.open", order:40, ... }`，出现在右侧栏 `+`/guide 页；这是官方推荐的 discoverability 入口（files/browser/terminal 都这么做）。
3. **快捷键**：`quickchat.open`，`resolve` 用 `commandTarget` + `openTabFromTarget`；guide 卡片自动显示键帽。
4. **可选（Phase 2）**：`conversation.session.header.utilities` 再放一个图标按钮（list 型、additive，见 §3.3.2）；**不要**用 `.corner`。
5. **hero**：有 session 的 blank hero（新建会话、未发首条消息）仍会渲染 `conversation.input.right`（`ui-conversation/lib/client.js:19080` 判断 `input !== undefined && sessionId !== undefined`；hero 判定 `17545`），因此主入口可用；**sessionless hero** 没有任何会话座位，只能靠浮窗降级（Phase 1 接受）。

---

## 6. 分阶段落地清单

> 所有改动集中在 `client/client.js`、`package.json`、`README.md`、`tests/`；host 半 `lib/` 不改（除设置迁移）。
> **不要动** `lib/index.js` 的 webServer/llm 流式逻辑：tab 化不需要 host 改动（这是本方案最重要的结论之一）。

### Phase 0：解除 P0 阻塞（0.5 天，先做，独立于 tab）

- [ ] `client/client.js:1148`：`plugin.inject` 删除 `'settingsScope'`。
- [ ] `client/client.js:1121-1134`：删除 `ctx.inject(['settingsScope'], …)` + `settings.plugin.item` 注册块（或加 `if (false)` 注释保留迁移线索）；删除 `quickChatSettingsScope` 残留。
- [ ] `tests/client/render-smoke.test.cjs:63,120,248-262`：更新 mock（不再提供 settingsScope，不再断言 settings.plugin.item）。
- [ ] `README.md`：删除/改写「设置 → 插件 → 插件配置」与旧 settings 段落；标注 0.2.1-rc.2 下设置卡片暂不可用。
- [ ] 验收：在 Lead 的冒烟实例（`/tmp/dsh-smoke`）刷新页面，控制台无 `web boot: … did not activate`；`conversation.input.right` 按钮出现、浮窗可开。

### Phase 1：最小可用 tab（1–2 天）

1. **package.json**
   - `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-sidebar-right`；若加快捷键 += `@deepseek-ai/dsh-client-shortcuts`。
   - 保持 `dsh.client.immediately: true`、`platform: "web"` 不变。
2. **client.js：注册三段**
   - 常量 `ID = "dsh-quickchat"`、`KIND = "quickchat"`、guide entry（§5.1）。
   - `ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => { … })`（可选注入，避免缺包时 pending）：
     - `scope.sidebarRightTabs.register(definition)`（包在 `scope.effect`）。
     - `scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name, key: ID, locale: NS }, QuickChatTabBody))`。
     - （可选）`sidebar.right.pane.tab.title` 静态标题 seat —— Phase 1 可省。
   - 设置 `tabIntegrationAvailable = true` 供按钮分支。
3. **UI 拆分**
   - 新增 `QuickChatTabBody`（§5.2 骨架），复用 `Header/Thread/Composer/RecentChats/ConversationRow` 与 `createApiClient`、`loadProject/selectConversation/…`。
   - 把全局 `panelStore`/`api`/`aborters` 改成 **per-body controller**（`createQuickChatController({ sessionId })`），组件内 `useSyncExternalStore` 订阅。
   - 删除 tab 路径上的 fixed/geometry/resize/Escape/outside-click；浮窗路径保留原样（降级）。
   - Header 的 `−` 改为 `useTabInfo().tab.actions.close()` 或直接移除。
4. **入口**
   - `Trigger` 的 onClick 改为 §5.5 `openQuickChat()`；按钮 `aria-label` 视状态为「打开临时对话/收起」。
   - 新增 shortcut `quickchat.open`（§3.3.3）+ `resolve` 用 `commandTarget`/`openTabFromTarget`。
   - 新增 i18n keys（quickChat/guideTitle/guideDescription/shortcut.open/shortcut.noSession）。
5. **验收清单（冒烟实例 + CDP）**
   - 点击 input.right 按钮 → 右侧栏展开并出现 quickchat tab，chip 文案正确。
   - 关闭 tab → 侧栏仅剩 guide 时自动收起（README 规则）；再次点按钮可重新打开。
   - 刷新页面 → tab 恢复、body 重新加载当前 project 的 Recent chats。
   - 新建 blank session（有 sessionId 的 hero）→ 主入口可用；同时打开两个同 project session 的 quickchat，切 session 互不串状态。
   - 侧栏收起/展开、切 tab、切 session 时流式输出与草稿不丢（keepMounted）。
   - 停用插件（或移除 tab 类型）→ 残留 tab 显示 "unavailable" 文案，不崩溃。
   - `localStorage['dsh.sidebar-right.v1.<sessionId>']` 里出现 `kind:"quickchat"` 记录。

### Phase 2：打磨（2–4 天）

- [ ] **动态标题**：注册 `sidebar.right.pane.tab.title`，显示最近/当前会话名（per-session store 或注入 observable）。
- [ ] **tab 菜单**：`sidebar.right.tab.menu.item` 加「在浮动面板打开 / 关闭」；浮动用 `ctx.sidebarRight.float(tabId)`，删除自绘浮窗（或保留为设置项）。
- [ ] **设置迁移**：`plugins.row.config`（key `dsh-quickchat#quickchat`，【推断】需验证）+ `ctx.configForms` 或自绘表单 + host 持久化（row config 或 HTTP 路由）；host `settings.installSection` 替换。
- [ ] **视觉统一**：改用 ui-primitives（Button/Tooltip/Menu/PathLabel…）与 `--dsw-alias-*` / `--dsh-*` 主题变量；去掉硬编码颜色与毛玻璃；适配窄侧栏（正常宽度下多列布局）。
- [ ] **状态增强**：触发按钮订阅 `openTabs` 显示 active/pressed；跨 pane 的已有 tab 聚焦；快捷键在无 session 时显示 blocked reason。
- [ ] **可选 header 按钮**：`conversation.session.header.utilities`（list，additive）。
- [ ] **评估 `multiple: true`**：若产品需要「一 chat 一 tab」，用 `navigation.params.chatId` + 动态标题。
- [ ] **文档**：更新 README（默认形态从浮窗改为右侧栏 tab；浮窗降级/移除说明；截图）。

---

## 7. 风险与未决问题

| # | 风险 | 影响 | 概率 | 缓解 / 验证 |
|---|---|---|---|---|
| R1 | **P0：`settingsScope` 注入不存在导致 client 插件 pending、web boot 失败**【实测】 | 插件完全不可用 | 已发生 | Phase 0 删除该 inject；冒烟实例检查 boot 控制台无 pending 报错 |
| R2 | 无 session（sessionless hero）没有右侧栏 surface，`openTab` 抛错 | 该场景无法用 tab | 确定 | Phase 1 保留浮窗降级（`mounted === undefined` 分支）；Phase 2 若要求覆盖，考虑 `conversation.header.leading` 或 `shell.overlay` launcher |
| R3 | keepMounted + 后台 session 多 body → 模块级单例状态串台 | 两个 session 的 quickchat 互相污染 | 高（若沿用 panelStore） | 强制 per-body controller；验收清单覆盖双 session |
| R4 | 触发按钮重复点击/跨 pane 已有 tab 的聚焦不完整 | 可能多开或落点不符预期 | 中 | Phase 1 用 `openTabs` 查已有 + `openTab` + `focus`；Phase 2 完善 |
| R5 | 插件停用/卸载后布局里残留 quickchat tab | 显示 unavailable | 低（预期行为） | 已验证 fallback 文案；文档说明 |
| R6 | guide 默认页规则：若 composition 只有 sidebar-right + quickchat，展开侧栏直接打开 quickchat | 与官方默认 guide 行为不同 | 低 | 无需处理；文档注明 |
| R7 | `title` 打开时快照 + 语言切换不重译 | chip 语言不一致 | 中 | Phase 2 title seat；Phase 1 接受 |
| R8 | 右侧栏正常宽度较窄（官方面板宽度自适应），quickchat 原 480px 浮窗布局在窄栏显得拥挤 | 体验 | 高 | Phase 1 用 `width:100%; minWidth:0` + 列布局；Phase 2 视觉打磨/响应式 |
| R9 | keepMounted 常驻内存（含后台 session body） | 长会话内存增长 | 中 | 流式/列表数据节制；必要时 Phase 2 关闭 keepMounted 并把流式状态外置 |
| R10 | 设置卡片迁移的 key 归属不确定（`dsh-quickchat#quickchat` 是否正确） | 设置页不显示 | 中 | 见附录 C 验证；【推断】 |
| R11 | 第三方占用 `conversation.session.header.corner`（single）会替换官方展开按钮 | 用户失去展开入口 | — | 方案明确禁用；用 list 型 utilities/actions |
| R12 | 官方未来把 quickchat 概念收编（kind 冲突） | 潜在共存/覆盖 | 低 | kind 取 `quickchat` + id 包名；extension band 天然最高 |

**未决问题（需产品/Lead 决策）**：
1. sessionless hero 是否需要 quickchat 入口？若要，选 root 座位（`conversation.header.leading` 单座、`shell.overlay` 自定义 launcher）还是接受浮窗降级。
2. 旧浮窗是「Phase 1 保留 + Phase 2 删除」还是「长期保留为可选项」？（推荐前者，float 面板可替代）
3. 设置卡片的迁移优先级：Phase 2 是否必须？host 侧 provider/model 配置改由 profile row config 还是 quickchat 自己的 HTTP 设置？【推断：用 row config 最省客户端代码】
4. 是否需要「同 project 多 session 的 quickchat 状态同步」？（推荐不做）
5. 是否要 `multiple: true`（一 chat 一 tab）？

---

## 8. 其他官方 workspace/右侧栏扩展面盘点（Q5）

结论：**0.2.1-rc.2 唯一的 tab 扩展系统就是 `ctx.sidebarRightTabs`**；其余「workspace/右侧栏」相关能力都是导航服务或 root/session 级 slot 座位，不能替代 tab，也没有更合适的接入点。

| 扩展面 | 包 | 形态 | 对 quickchat 的意义 |
|---|---|---|---|
| 右侧栏 tab（本方案） | `dsh-client-ui-sidebar-right` | `ctx.sidebarRightTabs` + keyed slots | ✅ 唯一 tab 机制，推荐 |
| 右侧栏 pane split / float / fullscreen | dockkit（baseline 模块）+ sidebar-right | kit chrome 手势、`ctx.sidebarRight.split/float/dock/toggleFullscreen` | tab 打开后**免费获得**：用户可把 quickchat 拖成浮动面板、分栏、全屏 |
| 全局中央面板 | `main`（keyed slot）+ `ctx.layout.selectPanel(panelId)`（catalog `runner:4324-4360`；`dsh-client-ui-renderer/lib/client.js`）；`sidebar.panellist`（catalog `5700-5760`） | 类似 Settings 的整页面板，占主列 | 备选：如果右侧栏太窄，可做「QuickChat 整页面板」；但会替代会话主界面，不适合常驻 |
| 左栏 workspace 浏览区 | `dsh-client-ui-workspace` + `sidebar.workspaces`（single root，已被 ui-workspace 占用，catalog `runner:6459-6510`） | 会话/工作区分组树 | ❌ 已占用；不是面板容器 |
| 会话行操作/菜单 | `sidebar.workspaces.session.row.action` / `sidebar.workspaces.session.menu.item`（list root；catalog `6517-6600,6571-6640`） | 左栏会话行按钮/菜单项 | 可加「在该会话打开 QuickChat」类入口（Phase 2 可选，非必需） |
| workspace 选择器 | `conversation.hero.workspace`（single root，catalog `3203-3270`）、`conversation.hero.workspace.directoryFlow`、`conversation.hero.brand.mark` 等 | Hero 区座位 | ❌ 不是 quickchat 的容器；`conversation.hero.options`（list session）可放 hero 小按钮 |
| workspace 通知 | `workspace.toast`（keyed root，catalog `6813-6870`） | 通知卡片 | 与本方案无关 |
| 导航/数据服务 | `ctx.workspaces`（create/rename/delete/archive/insertSessionBefore；catalog `1615-1695`）、`ctx.uiWorkspace`（openSession/openWorkspace；catalog `1489-1520`）、`ctx.sessions`（retain/fork/search；catalog `1266-1400`）、`ctx.layout`（selectPanel/openRightbar/closeRightbar；catalog `1127-1180`） | 服务 | 可用于「点会话标题跳到主会话」等交互，但不提供 tab 容器 |
| 右侧栏其它扩展座位 | `rightbar`/`rightbar.session` 由 sidebar-right 自己声明（single/keyed，catalog `4793-4880`）；`sidebar.right.tab.document*` 是 documentpreview 的嵌套文档渲染链 | 内部/专用 | 第三方不要去注册 `rightbar`（single，会被替换导致右侧栏失效） |
| dockkit | `@deepseek-ai/dsh-client-ui-dockkit` 是基线模块（无 ctx service） | 布局纯函数 + 组件 | sidebar-right 内部使用；第三方无须直接调用 |

> 检索方式留档：`grep -rn "sidebarRightTabs" $AI --include=*.js` 只命中 sidebar-right 及其注册方（files/terminal/browser/documentpreview/plan/schedule/deliverables/subagent/session-inspector），说明**不存在第二套 tab 注册表**；`grep -rn "workspace tabs\|workspaceTabs"` 无命中。

---

## 附录 A：证据索引

> 路径简写：`SR` = `/tmp/dsh-021/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right`；`CAT` = `.../dsh-cordis-client-runner/lib/client.js`（由源码 AST 生成的 contract 目录）；`FILES`/`TERM`/`BROWSER`/`DOCPREV` = 对应官方 sidebar 包。

| 主题 | 证据 |
|---|---|
| 两段式注册文档 | `SR/README.md:81-88`；`SR/README.md:104-121` |
| 注册表实现（RANKS/coexists/matcher/register/candidates/claim/refresh） | `SR/lib/client.js:4394-4436,4440-4630` |
| `defaultSeed` / `pageAddress` | `SR/lib/client.js:585-596,599-608` |
| TabSlot 分发 / keepMounted / title wrapper | `SR/lib/client.js:1253-1338` |
| `tabInfoFactory`（useTabInfo 实现） | `SR/lib/client.js:4739-4776` |
| TabDomain / occurrence / tabActions(bindCommands/openResource/openTab/close) | `SR/lib/client.js:1778-1905` |
| openTabs 元数据清单 | `SR/lib/client.js:1921-1975,2026,2067` |
| 控制器 openResource/openTab/placeTab/place/require | `SR/lib/client.js:2119-2225,2479-2488` |
| `openTabFromTarget`/`commandTarget`/`focusedTarget` | `SR/lib/client.js:2272-2320` |
| close/toggle/focus/split/float/dock/fullscreen | `SR/lib/client.js:2226-2440` |
| `registerCloseHandler` / `mounted` / `tabsIn` | `SR/lib/client.js:2063-2105` |
| seat 声明（rightbar.rightbar.session + children） | `SR/lib/client.js:4913-4960` |
| header.corner 被 ExpandButton 占用 | `SR/lib/client.js:4962-4970`；`CAT:3923-3998`（occupants） |
| 官方 inject 列表与 reflect.provide | `SR/lib/client.js:4787-4797,4848-4849` |
| terminal 最小页面型注册 | `TERM/lib/client.js:350-358,438-493` |
| files 最小资源型注册 + body cwd | `FILES/lib/client.js:15-35,595-605,996-1021` |
| browser multiple/keepMounted | `BROWSER/lib/client.js:1430-1454,1603-1645` |
| documentpreview 公开路径活证据 | `DOCPREV/lib/client.js:1076-1088,7180-7258` |
| plan 的 patterns/canOpen | `.../dsh-client-ui-plan/lib/client.js:630-639` |
| slot 座位 contract（kind/scope/options/occupants） | `CAT:3146,3671,3861,3923,3999,4324,4480,4658,4711,4793,4822,5433,5748,5802,5853,6162,6205,6248` |
| slots register/inject service 实现 | `dsh-client-ui-renderer/lib/client.js:1305-1440,1598-1650` |
| 标准 props / inject 参数类型 | `CAT:2150-2215`（PropsRuntime/SlotInjectFace/InjectParams/SessionStandardProps 等） |
| guide 内部（commandId → 键帽、默认页规则） | `SR/lib/client.js:507-545`；`SR/README.md:115,119` |
| `dsh.client` 声明解析 / 图排序 | `dsh-client-modules/lib/index.js:48-77,414-437`；`lib/client.js:776-796` |
| 平台基线模块种表 | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`function SZ` 返回 react/cordis/zod/dsh-client-store/ui-slots/ui-primitives/ui-dockkit） |
| boot 失败语义（pending services） | 同上前端 bundle（`function bZ`：`web boot: N entries did not activate` / `pending (waiting for services: …)`） |
| 官方设置卡片新 API 范例 | `dsh-client-ui-settings-agent-loop/lib/client.js:130-160`；`dsh-client-ui-settings/lib/client.js:1266-1330`；`dsh-client-ui-plugin-manager/lib/client.js:24-33,2807-2820` |
| 平台/包版本 | `/tmp/dsh-021/dsh/package.json:1-4`（`@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.2`） |

## 附录 B：quickchat 现状代码地图

`/Users/gc/dsh-plugin-quickchat/client/client.js`（1172 行，lazy-CJS bundle）：

| 行 | 符号 | tab 化处置 |
|---|---|---|
| 17-18 | `NS = 'dsh-quickchat'`, `ROUTE` | 复用；NS 继续作为 locale namespace |
| 21-... | `dictionaries {zh,en}` | 复用 + 新增 tab/guide/shortcut keys |
| 266-295 | `createQuickChatStore(project)` | 改为 per-body controller（或 slot store） |
| 296-302 | `projectKeyOf` | 复用 |
| 362-... | `createApiClient(fetchImpl)` | 原样复用（host HTTP API 不变） |
| 507-512 | `pluginCtx / panelStore / api / loadSerial / aborters` 单例 | ❗ 拆掉单例，改 per-body |
| 513-537 | `currentSessionContext` / `projectContextForSession` | `projectContextForSession` 复用；`currentSessionContext` 仅浮窗降级用 |
| 542-559 | `loadProject(context)` | 移入 controller，用 body 的 sessionId 解析的 context |
| 597-... | `selectConversation` / `createConversation` / `renameConversation` / `removeConversation` | 移入 controller |
| 620-704 | 流式发送 / stop / `aborters` | 移入 controller；关闭时 abort |
| 705-717 | `Trigger`（input.right 按钮） | 保留座位，改 onClick 行为（§5.5） |
| 718-755 | `Header`（`+` `−` 按钮） | 复用；`−` 改关闭 tab 或移除 |
| 756-779 | `RecentChats` | 复用（去掉 fixed 高度假设） |
| 780-797 | `Thread` | 复用 |
| 798-820 | `Composer` | 复用（IME 逻辑保留） |
| 821-... | `ResizeHandle` | ❌ tab 内删除 |
| ~1060-1096 | `QuickChatPanel`（fixed shell + Escape/outside dismiss + geometry） | ❌ 拆成浮窗降级组件 + 新 `QuickChatTabBody` |
| 1096-1099 | `bindLocale` | 复用 |
| 1101-1145 | `registerClient` | 重写注册段：+ tab 三段；- settings.plugin.item |
| 1107-1112 | `conversation.input.right` 注册（id/order/locale） | ✅ 保留（Phase 1 唯一改动是点击行为） |
| 1114-1119 | `shell.overlay` 注册 | Phase 1 保留（降级）；Phase 2 决定去留 |
| 1121-1134 | `settingsScope` + `settings.plugin.item` | ❌ Phase 0 删除/短路 |
| 1148 | `plugin.inject` 数组（含 `settingsScope`） | ✅ Phase 0 移除；Phase 1 加 sidebar 服务（可选注入） |
| host `lib/index.js:21-42` | `apply(ctx, config)` / `settings.installSection` | host API 不动；`installSection` 若确认不存在则删除（独立小任务） |
| host `lib/route-handler.js` | `/quickchat/api/conversations*`（list/create/rename/remove/messages GET/POST/cancel） | 完全不动 |

## 附录 C：验证方法

1. **P0 boot 验证**（Lead 的冒烟实例 `/tmp/dsh-smoke`，无头 Chrome CDP 9223）：
   - 刷新页面，收集 console：不应出现 `web boot: … did not activate` / `pending (waiting for services: settingsScope)`。
   - Boot 卡（`[data-dsh-boot]`）应在 roster 全部 active 后消失。
2. **tab 注册验证**：
   - 打开会话 → 点击 input.right 的 quickchat 按钮 → DOM 应出现：`[data-sidebar-right-tab]`（body wrapper）、`[data-sidebar-right-occurrence]`、`[data-sidebar-right-guide-entry]`（guide 卡片，若点开 guide）。
   - `localStorage.getItem('dsh.sidebar-right.v1.'+sessionId)` JSON 中 `layout.tabs` 含 `kind:"quickchat"`、`contentId:"sidebar://quickchat"`。
   - 若注册失败：控制台会出现 `sidebarRight: tab type id "…" is already registered` / `tab kind "…" is already registered`（说明 id/kind 冲突）。
3. **第三方可见性验证**：`ctx.sidebarRightTabs` 可注入（本方案注册成功即证明）；补充证据：`ctx.slots.snapshot()`（renderer 提供的只读组合树）中应出现 `sidebar.right.pane.tab` 下 key = `dsh-quickchat` 的 occupant。
4. **多实例隔离验证**：同一 project 建两个 session，各打开 quickchat tab，A 发消息/切换会话，B 面板不受影响（确认无 panelStore 串台）。
5. **keepMounted 验证**：quickchat 流式中切到另一 tab / 收起侧栏 5s 再回来，流式仍继续或已完整落地（不中断）。
6. **无 session 降级验证**：从无会话首屏检查按钮是否出现（预期：`sessionId === undefined` 时 input.right 不渲染 → 无按钮；浮窗若之前打开仍可操作）；点击按钮时若 `mounted === undefined` 走浮窗分支、无异常。
7. **设置 key 验证（R10）**：在 Settings → Plugins 打开 `dsh-quickchat` 的 bundle 页/行页，检查是否出现 `plugins.row.config` 的 configure 入口；DOM 中 key 可通过 plugin-manager 的 `rowConfigKey(bundle, rowId)` 反推（bundle = 包名，rowId = `cordis.patch.yml` 的 `id: quickchat`）。
8. **代码级快速检查**（不启动服务）：
   - `grep -n "sidebarRightTabs.register" client/client.js`（应命中类型注册）
   - `grep -n "sidebar.right.pane.tab" client/client.js`（应命中 body/title 注册）
   - `grep -n "settingsScope" client/client.js`（应无命中）

## 附录 D：推断与未确证项

| 项 | 状态 | 验证方法 |
|---|---|---|
| `settings.plugin.item` & `settingsScope` 在 0.2.1-rc.2 不存在 | 【确证】全树 grep 无命中 + Lead 实测 pending | 已由 Lead 实证 |
| 第三方设置卡片 key = `dsh-quickchat#quickchat` | 【推断】由 `rowConfigKey(bundle,rowId)` 推出，bundle 归属取决于 profile 行组合方式 | 附录 C.7 |
| 同 project 多 session 的 keepMounted body 会同时挂载 | 【确证】README:61 + RightbarRoot 描述；具体在用户场景的出现条件可在冒烟实例用 DOM 中子树的 `data-sidebar-right-session` 数量确认 | 打开两个 session 各开 tab，检查 DOM |
| hero（有 sessionId 的 blank 状态）下 `mounted` 指向该 session | 【推断】由 `mounted` 定义（"the selected Session while the Conversation fills the main column"）与 hero 判定 `ui-conversation/lib/client.js:17545` 推出 | 在新建会话未发消息时点按钮，检查 `openTab` 是否成功（不抛 "no session surface"） |
| blank hero 下 `conversation.input.right` 仍渲染（主入口可用） | 【推断】渲染守卫是 `input !== undefined && sessionId !== undefined`（`ui-conversation/lib/client.js:19080`），blank hero 若无 sessionId 则不渲染 | 新建会话（不发消息）观察按钮是否存在；再切到完全无会话首屏对比 |
| `ctx.sidebarRight.float()` 可把 quickchat tab 变浮动面板 | 【确证】方法存在（`SR/lib/client.js:2430-2440` 附近）+ README:48 浮动面板能力；具体交互体验需实测 | 冒烟实例手动拖拽/调用 |
| 语言切换后 tab chip 不重译 | 【确证】README:126,146 + `title()` 打开时快照 | 冒烟实例切换语言观察 chip |
| `conversation.header.leading` 在 sessionless hero 渲染 | 【推断】contract 描述 "available without a Session" | 冒烟实例注册临时按钮观察 |
