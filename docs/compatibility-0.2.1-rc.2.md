# dsh-quickchat 兼容性审计：对照 DSH 0.2.1-rc.2

> 审计对象：`/Users/gc/dsh-plugin-quickchat`（插件 `dsh-quickchat@0.1.0`，当前工作树，含未提交的 `client/client.js` 弹窗 resize 改动）
> 权威比对源：用户桌面 App（`/Applications/DeepSeek Harness.app`，0.2.1-rc.2）的 app.asar 解包源码 `/tmp/dsh-021/dsh/node_modules/@deepseek-ai/`（307 个包，`lib/index.js` = host 半，`lib/client.js` = client 半，`README.md` = contract 文档），以及随包发布的 Web shell `/tmp/dsh-021/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（单行压缩产物）。
> 证据强度标注：**源码确证** = 直接读到 0.2.1-rc.2 实现/类型声明；**动态确证** = Lead 在隔离 `DSH_HOME`（`/tmp/dsh-smoke`）+ 无头 Chrome（CDP 9223）真机实测；**推断** = 基于源码语义、未在真机复现。

---

## 一、结论摘要

1. **P0（灾难级）：插件在当前安装形态（web profile）下会让整个 WebUI 无法启动。** client 半 `plugin.inject` 里的 `settingsScope` 在 0.2.1-rc.2 中不存在；cordis 对缺失依赖的 fiber 永远不激活，而 Web shell 的启动审计会把任何 pending entry 视为启动失败并抛错，首页停在 "Failed to load plugins / web boot: 1 entry did not activate / dsh-quickchat: pending (waiting for service: settingsScope)"。**动态确证**：去掉该服务名后 boot 恢复正常，触发按钮与浮窗均出现（见附录 A）。
2. **Host 半基本兼容（动态确证）**：`inject: ['webServer','llm','agentDefaultModel']` 三个服务名都仍存在；`ctx.webServer.register({kind:'prefix',path,handler})`、`ctx.effect`、`ctx.llm.stream`（含主回答与标题生成）、`ctx.agentDefaultModel.currentSelection()`、`resolveCallConfig/listProviders/listModels/resolveModelInfo` 均仍按插件假设工作。仅 `/quickchat/api` 路由实测 200。
3. **唯一的 Host 半硬伤是 `settings.installSection` 已被整体移除**（0.2.1-rc.2 全源码/全 shell 无此字符串）。该调用运行在可选子 fiber 中：**不会阻断插件/应用启动，但该子 fiber FAILED，模型路由设置永久失效**（静默回退到 `agentDefaultModel`）。定性 P1。
4. **Client 设置卡片（模型选择）整条链路已不存在**：`settingsScope` 服务与 `settings.plugin.item` slot 在 0.2.1-rc.2 中均无任何定义。替代面是 `configForms` 服务 + `plugins.item` slot（官方 `ui-settings-web-search` / `ui-settings-shell` / `ui-settings-subagent` 的现行写法）。定性 P1，修复需 host/client 联动（volatile Config）。
5. 其余为 P2：标题生成细节退化（`tool-call` chunk 类型已不存在、64 token 上限对 reasoning 模型会直接退化、消息 source kind 非规范）、`res.flush` 在 node ServerResponse 上是 no-op、`sessions.list` 快照已无 `current` 字段导致浮窗打开后不再跟随主会话切换（P1 边缘/P2）、package.json 无法表达 DSH 兼容范围等。
6. **范围事实**：插件只装在 `~/.dsh/profiles/web`（symlink 到本仓库），用户实际运行的桌面 GUI 使用 `~/.dsh/profiles/desktop`，其中未安装本插件——**当前桌面 App 不受 P0 影响**；但若把插件装进 desktop profile，client 半同一个 P0 会在桌面渲染器里复现（同一 Web shell 启动审计，推断）。

**总评：Host 半 ≈ 兼容；Client 半在 0.2.1-rc.2 启动即 P0，必须修复后才能谈功能。**（插件现有 56 个 `node --test` 全绿，但测试均为 mock，未覆盖真实宿主契约，不能作为兼容证据。）

---

## 二、兼容矩阵

### A. Host 半

| # | 契约/API | 插件用点 | 0.2.1-rc.2 状态 / 现实签名 | 结论 | 级别 | 证据 |
|---|---|---|---|---|---|---|
| A1 | 插件 `inject: ['webServer','llm','agentDefaultModel']` | `lib/index.js:6` | 三个服务名都存在：`webServer` = `super(ctx,"webServer")`；`llm` = `super(ctx,"llm")`；`agentDefaultModel` = `super(ctx,"agentDefaultModel")` | 兼容 | — | `dsh-host-webserver/lib/index.js:286`、`dsh-llm/lib/index.js:1816`、`dsh-agent-default-model/lib/index.js:27`（源码确证；动态确证：插件被组合进宿主） |
| A2 | `ctx.webServer.register({kind:'prefix', path, handler})` + 前缀匹配 | `lib/index.js:25-27`（`ROUTE_PREFIX='/quickchat/api'`，`lib/route-handler.js:3`） | `register(route)` 仍按 `kind==='exact'|'prefix'` 分表；匹配规则“exact → 最长 prefix → fallback”，prefix 命中 `pathname===prefix || startsWith(prefix+'/')`；返回 disposer | 兼容 | — | `dsh-host-webserver/lib/index.js:326-333`、`:494-503`（源码确证；动态确证：`/quickchat/api/conversations` 200） |
| A3 | `ctx.effect(() => ctx.webServer.register(route), label)` | `lib/index.js:26-30` | `ctx.effect(execute,label?)` 仍是 cordis 4.0.5 原生 API，register 的 disposer 作为 effect 清理 | 兼容 | — | `cordis/lib/index.js:1169`（源码确证） |
| A4 | handler 直接拥有 node `req/res`（`writeHead/write/end`、`for await…of req`、`req.on('aborted')`） | `lib/route-handler.js:36-41,46,100-105`、`lib/http.js:22-39` | 0.2.1-rc.2 仍以 `await route.handler(req,res)` 调用原始 `node:http` 对象；gzip 中间件用 `Cache-Control: no-transform` 豁免（插件已设置 `no-transform`） | 兼容 | — | `dsh-host-webserver/lib/index.js:376-409`、`:196-220`；README“Cache-Control: no-transform … remain unchanged”（源码确证；gzip 依赖为外部 `compression` 包，未在 asar 内，行为属**推断**） |
| A5 | `res.flush?.()` 主动 flush | `lib/route-handler.js:101` | 原生 `ServerResponse` 没有 `flush()`（那是 express/compression 的扩展），可选链使其为 no-op；node 自身逐 chunk 写出，功能不坏 | 兼容（语义打折扣） | P2 | `dsh-host-webserver/lib/index.js:376-390` 直接传原生 res（源码确证） |
| A6 | `ctx.inject(['settings'], cb)` 晚绑定 API | `lib/index.js:32-41` | `ctx.inject(inject, callback)` 仍存在（= `ctx.plugin({inject,apply,name})`） | API 兼容 | — | `cordis/lib/index.js:1600-1607`（源码确证） |
| A7 | `settings.installSection(ns, schema, defaults, {setSource,onChange})` | `lib/index.js:34-40` | **已移除**。0.2.1-rc.2 `settings` 服务是 `SettingsForms`：`configure(presentation, owner)`、`describe()/update()/replace()/mutate()/reset()`；表单元数据只来自插件自身 `Config` 中 `.volatile()` 字段，按 **profile entry id** 索引，无 installSection/setSource/onChange | **不兼容** | **P1** | `dsh-settings/lib/index.js:322-369,405-475`、README:12,33,39；grep 全 307 包+shell：0 处 `installSection`（源码确证） |
| A8 | `ctx.llm.stream(options)` 主回答 | `lib/quickchat-service.js:390-412` | 仍存在：`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions` 含 `provider/model/messages/system/tools?/temperature?/maxTokens?/stop?/signal?/sessionId?/purpose?`；chunk 有 `text-delta/finish/...`；finish `{kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'}` | 兼容（细节见 A9/A10） | — | `dsh-llm/lib/index.js:2393`、`dsh-llm/lib/typert.host.js:264,359-360,571`（源码确证） |
| A9 | 标题生成 stream 的 chunk 判定 `chunk.type==='tool-call'` | `lib/quickchat-service.js:273` | 0.2.1-rc.2 `StreamChunk` 联合类型中**没有** `tool-call`，只有 `tool-call-delta` + `block-end{block.type:'tool-call'}` → 该判断永远为 false（死代码） | 退化（无害） | P2 | `dsh-llm/lib/typert.host.js:571`（源码确证） |
| A10 | 标题生成参数 `maxTokens:64`、`purpose:'session-title'`、`system`、消息 source `{kind:'plugin',plugin}` | `lib/quickchat-service.js:258-281,128-135` | `purpose/system/maxTokens` 合法；官方标题器用 `prepareCall` + `maxOutputTokens:4096`（配置注释明确 reasoning token 也计入输出上限），消息 source 用生产者名 kind `'dsh-session-title-llm'`；`MessageSourceMap` 无 `'plugin'` 这个 kind（运行时 adapter 不读非 assistant 消息 source，不会抛错，但契约上非规范） | 退化 | P2 | `dsh-session-title-llm/lib/index.js:177,180-195`、`dsh-llm/lib/typert.host.js:475`、`dsh-llm-deepseek/lib/index.js:1515`（源码确证 + 推断） |
| A11 | `ctx.agentDefaultModel.currentSelection()` 读取宿主默认路由 | `lib/quickchat-service.js:203-221` | 服务名与 shape 均保留：`currentSelection(): {provider, model, reasoningEffort?}` | 兼容 | — | `dsh-agent-default-model/lib/index.js:27,36-51`（源码确证） |
| A12 | `ctx.llm.resolveCallConfig / listProviders / listModels / resolveModelInfo` + `info.context.contextWindow` | `lib/quickchat-service.js:224-256` | 均存在：`resolveCallConfig(config,signal)`、`listProviders(): LlmProviderInfo[]`、`listModels(provider)`、`resolveModelInfo(provider,model,signal)` 返回 `LlmResolvedModelInfo{context?:{contextWindow:number}}` | 兼容 | — | `dsh-llm/lib/index.js:1908,2086,2111,2174`、`typert.host.js:451`（源码确证） |
| A13 | 流事件 `chunk.reason.failure.code/message` 映射 | `lib/quickchat-service.js:400-419` | `FinishReason.error/aborted` 的 `failure: LlmFailure{message,code,status?,...}` | 兼容 | — | `dsh-llm/lib/typert.host.js:411`（源码确证） |

### B. Client 装配（manifest / module loader / bundle）

| # | 契约/API | 插件用点 | 0.2.1-rc.2 状态 / 现实签名 | 结论 | 级别 | 证据 |
|---|---|---|---|---|---|---|
| B1 | `package.json` `dsh.client = {platform:'web', immediately:true, inject:[…]}` | `package.json:33-47` | `parseDshClient` 接受 string `platform`、string[] `inject`、string[] `external`、boolean `immediately`；`platform!=='web'` 的包不入 roster | 合法 | — | `dsh-client-modules/lib/index.js:62-76,733`（源码确证） |
| B2 | `exports['./client'] = './client/client.js'` | `package.json:12` | `clientExportOf` 接受 string 或 `{default:string}`；随后 `join(pkgdir, clientRel)` 读 bundle，缺失则报 `MissingClientBundleError` | 合法（bundle 存在） | — | `dsh-client-modules/lib/index.js:172-182,737-748`（源码确证） |
| B3 | `dsh.client.inject` 9 个包名 | `package.json:36-46` | 语义是“本 row 之前先到位的 package row”（`arriveGraphRow` 对存在 row 递归预载，不存在则忽略）；9 个包在 0.2.1-rc.2 web 组合里都存在且是 web client 插件 | 合法（列表基本冗余，见 P2-4） | P2 | `dsh-client-modules/lib/client.js:776-794`；各包 `dsh.client`；`dsh-web-app/cordis.patch.yml`（源码确证） |
| B4 | `window.__ModuleLoader__.load({id, factory:(require)=>{…}})` 契约 | `client/client.js:8-10` | 完全一致：官方 bundle 头部同形；`id` 必须等于 boot graph row id（= package.json `name`），插件 id `'dsh-quickchat'` 与包名一致；factory 返回值即模块 exports（`materialize().exports`） | 兼容 | — | `dsh-client-modules/lib/client.js:1,804-829`；官方样例 `dsh-client-ui-conversation/lib/client.js:1`（源码确证） |
| B5 | factory 返回插件对象而非 `module.exports` | `client/client.js:1146-1170` | 模块系统把 factory 返回值当 exports；Loader 用 `unwrapExports(exports.default ?? exports)` 得到 `{name,inject,apply}` 对象插件，cordis 接受 | 兼容 | — | `dsh-client-modules/lib/client.js:817`、`cordis-plugin-loader/lib/index.js:666-672`（源码确证） |
| B6 | `require('react')`（无 `external` 声明） | `client/client.js:11-17` | shell 静态模块表 `{react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod, @tanstack/react-virtual, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit}` 覆盖 react，无需 external | 兼容 | — | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`SZ()` 表，压缩单行）（源码确证） |
| B7 | `dsh.bundle.patch` + profile bundle 组合 | `package.json:29-32, cordis.patch.yml` | 0.2.1-rc.2 先做兼容性门禁（`engines.dsh` 优先，否则 `@deepseek-ai/dsh*` peerDeps；不满足 → bundle/row 被 skip 或 disabled）。插件两样都没声明 → 不会被拦，但无法表达兼容范围；实测 `dshmarket` 就是被此门禁 skip 的 | 合法（建议补声明） | P2 | `dsh-app-boot/lib/index.js:279-347,1017-1028,2305-2330`；动态确证见 `/tmp/dsh-smoke/server3.log` 首行（源码确证 + 动态确证） |

### C. Client 运行时服务与 slot

| # | 契约/API | 插件用点 | 0.2.1-rc.2 状态 / 现实签名 | 结论 | 级别 | 证据 |
|---|---|---|---|---|---|---|
| C1 | `plugin.inject` 中的 `settingsScope` | `client/client.js:1148` | **全源码/全 shell 0 处**。cordis fiber 的 `_refresh()` 在任一 inject 缺失时把 epoch 置 INACTIVE（永不 apply）；Web shell 启动审计随后抛 "N entries did not activate … pending (waiting for service: settingsScope)"，整页停在 boot 失败页 | **不兼容·启动阻断** | **P0** | 插件 `client/client.js:1148`；`cordis/lib/index.js:1306-1317,1240-1291`；shell boot 审计 `kZ/bZ`（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`）；动态确证见附录 A（源码确证 + 动态确证） |
| C2 | `ctx.inject(['settingsScope'], …)` + `settingsScope.bind({namespace})` | `client/client.js:1121-1133` | 服务不存在 → 回调永不执行（不会抛错）。即使存在，`bind/getSnapshot/set` 这套 API 也已被 `configForms` 取代 | 不兼容（死代码） | P1（含在 C3） | grep 全源码 0 处；`dsh-client-ui-settings/lib/client.js:1270-1335,1104-1196`（源码确证 + 动态确证：去掉 inject 项后无报错） |
| C3 | slot `'settings.plugin.item'` + 注册参数 `{name,key,locale,inject}` | `client/client.js:1126-1131` | **slot 不存在**（全源码/全 shell 0 处）。`ctx.slots.inject('settings.plugin.item', cb)` 因声明永不到来而静默不注册 → 模型设置卡片消失。0.2.1-rc.2 的替代面：官方插件配置页注册到 **`plugins.item`**（Plugins 页面卡片/详情页），并用 **`configForms`** 读写；`settings.plugins.tab`/`settings.section`/`settings.general.item` 是设置页的其他用途（见修复建议） | **不兼容** | **P1** | `dsh-client-ui-settings-plugins/lib/client.js:43-58`（“configuration pages … register into the Plugins page”）；`dsh-client-ui-plugin-manager/lib/client.js:30-65,2672-2682,2747-2755,4432`；官方样例 `dsh-client-ui-settings-web-search/lib/client.js:487-520`（源码确证） |
| C4 | slot `'conversation.input.right'` | `client/client.js:1107-1112` | 仍存在：list / scope=session，在 composers 的 children 中声明；注册参数 `id`(必填)、`order`、`label`；session 作用域 entries 的 standard props 含 **`sessionId`** | 兼容 | — | `dsh-client-ui-conversation/lib/client.js:19904-19907,19080`；`dsh-cordis-client-runner/lib/client.js:3671-3718`（standardProps 见 3713 行 `sessionId: SessionId`）（源码确证 + 动态确证：按钮出现且项目解析成功） |
| C5 | slot `'shell.overlay'` | `client/client.js:1114-1119` | 仍存在：list / scope=root、click-through 浮层、`id` 必填；官方包同样用法 | 兼容 | — | `dsh-client-ui-layout/lib/client.js:638-650,313`；`dsh-cordis-client-runner/lib/client.js:5433-5497`（源码确证 + 动态确证：`[data-quickchat-dialog]` 出现） |
| C6 | `ctx.locale.register(ns, {zh,en})` / `ctx.locale.bind(ns)` | `client/client.js:1096-1105`；字典 zh/en 见 `28-101` | 两种签名都保留：`register(ns, dicts)` / `register(ns,locale,dict)`；`bind(ns)` 返回稳定 t | 兼容 | — | `dsh-client-locale/lib/client.js:1387-1429`；`dsh-cordis-client-runner/lib/client.js:1226-1290`（源码确证） |
| C7 | `ctx.sessions.list.getSnapshot()` / `.subscribe` | `client/client.js:513-521,1135-1143` | 服务由 `ClientSessions` 提供，`list` 是 snapshot store，快照字段为 `{ids, byId, phase, projectionsBySession}`——**没有 `current`**；`byId[id]` 行含 `{id, displayTitle, running, retainedBy, blank, updatedAt, formatStatus, title?, cwd?, …}` | 部分兼容：读 `row.cwd` 正确，读 `.current` 恒为 undefined | **P1** | `dsh-api-session-controller/lib/client.js:3814-3819,3840,4155-4166`；插件 `client/client.js:524`（源码确证） |
| C8 | `ctx.workspaces.list.getSnapshot().items[].sessionIds/.path` | `client/client.js:527,531-532` | 快照 `{items, archivedSessionIds, pinnedSessionIds, state, phase, error}`；workspace 项 `{workspaceId, path, title, sessionIds, createdAt, updatedAt}` —— 插件读取的字段仍存在 | 兼容（字段层面） | — | `dsh-api-workspace-controller/lib/client.js:259-267,389-392`、`lib/typert.host.js:51-57`；`dsh-client-ui-workspace/lib/client.js:864,1423`（源码确证；动态确证：项目标题 `default-workspace` 正确） |
| C9 | `ctx.remote` / `ctx.remote.llm` / `ctx.remote.session` | `client/client.js:1130,1148`；卡片 `935-985` | `remote` 服务 + 由 typert 动态安装的 `remote.<namespace>` 服务仍在；`remote.llm`、`remote.session` 被官方包放在 inject 里 | 兼容 | — | `dsh-api-gateway/lib/client.browser.js:1605,1626,2075`；官方 inject 例 `dsh-client-ui-settings-models/lib/client.js:4422`、`dsh-client-ui-open-in-app/lib/client.js:750`（源码确证 + 动态确证） |
| C10 | `remote.llm.listModels` 作为目录回退 | `client/client.js:955-983` | `llm` 的远端暴露面只有 `listProviders / listConfigurableProviders / discoverModels`；**`listModels` 没有 `@Remote`**，客户端 `remote.llm.listModels` 为 undefined；官方客户端统一用 `remote.session.modelCatalog()` 取模型目录 | 不兼容（仅影响设置卡片回退分支） | P1（随 C3 修复） | `dsh-llm/lib/typert.remote-client.js:56-133`、`dsh-llm/lib/typert.host.js:165,235`；`dsh-api-session-controller/lib/typert.remote-client.js:1668`（源码确证） |
| C11 | `remote.session.modelCatalog()` 返回结构 `{groups:[{id,name,models:[…]}],…}` | `client/client.js:906-920,935-953` | 一致：`{default, routableProviders, groups:[{id,name,models:[{id,name,…}]}], failures}`，`remote` 结果为 `{ok,value}` | 兼容 | — | `dsh-api-session-controller/lib/typert.host.js:707-746`、`lib/typert.remote-client.js:1668`（源码确证） |
| C12 | `ctx.slots.register` 的 `order/locale/inject` 参数语义 | `client/client.js:1107-1119` | 仍是同一套：list entry 用 `id`，keyed slot 才用 `key`；`locale` 绑定 standard `t`；`inject` 在官方 settings 卡片仍在用 | 兼容（当前 slot 均 list，`key` 无意义） | — | `dsh-client-ui-renderer/lib/client.js:1603-1620,683-760`；官方 `settings-web-search` 注册样例（源码确证） |
| C13 | 面板几何/主题依赖 `[data-conversation-scroll]`、`--dsw-alias-*` | `client/client.js:26,120-129`；颜色 `103-113` | 两者都仍在：`[data-conversation-scroll]` 是含 transcript+composer 的 scrollBody；alias token 在 shell CSS 中大量使用 | 兼容 | — | `dsh-client-ui-conversation/lib/client.js:17863-17876`；`dsh-web-frontend/dist/assets/index-BxpfOGf3.css`（源码确证） |

### D. 其他环境/打包事实

| # | 事实 | 结论 | 级别 | 证据 |
|---|---|---|---|---|
| D1 | 插件只装在 `~/.dsh/profiles/web`（symlink 到仓库）；`~/.dsh/profiles/desktop` 的 profile package.json/bundles 中没有 `dsh-quickchat` | 用户当前运行的桌面 App 不受 P0 影响；web profile（`dsh --profile web`）会 P0。若装到 desktop profile，同一 client P0 会在桌面渲染器复现（使用同一 Web shell 启动审计） | 说明 | `~/.dsh/profiles/desktop/package.json`、`~/.dsh/profiles/web/package.json`（源码确证；desktop 行为为推断） |
| D2 | web profile 同时用 `dsh.profile.bundles` 和 `cordis.patch.yml` 的 `- id: quickchat` 指定插件 | bundle patch 已 insert 行 `id: quickchat`；profile patch 再按 id 覆盖同名校验配置，当前无害；注意设置命名空间将依赖这个 **entry id `quickchat`** | 说明 | `cordis.patch.yml`、`~/.dsh/profiles/web/cordis.patch.yml:4-5`（源码确证） |
| D3 | 兼容性门禁 | 0.2.1-rc.2 按 `engines.dsh`（存在则单独判定）或 `@deepseek-ai/dsh*` peerDependencies 判定，不满足则 bundle skip / row disabled。插件两者皆无 → 不会被拦，也无法表达兼容范围 | P2 | `dsh-app-boot/lib/index.js:279-347,1017-1028,2305-2330`；`/tmp/dsh-smoke/server3.log:1`（动态确证） |

---

## 三、P0–P2 问题清单

### P0（插件加载/主功能不可用）

#### P0-1 client 插件注入不存在的 `settingsScope` → 整个 WebUI 启动失败
- **现象**：web profile 打开页面停在 “Failed to load plugins”，控制台 `web boot: 1 entry did not activate` / `dsh-quickchat: pending (waiting for service: settingsScope)`；触发按钮、浮窗、locale、slots 全部不注册。
- **根因链**：
  1. `client/client.js:1148` `inject: ['slots','sessions','workspaces','locale','settingsScope','remote','remote.llm','remote.session']`；
  2. `settingsScope` 在 0.2.1-rc.2 中不存在（全源码/全 shell 0 处）；
  3. cordis `Fiber._refresh()`：任一 inject 无实现 → epoch = INACTIVE → plugin apply 永不执行（`cordis/lib/index.js:1306-1317`）；
  4. Web shell boot 审计 `kZ()` 在 `loader.await()` 后调用 `bZ()`：任何非 ACTIVE 的 entry（pending）都会被收集成“did not activate”并 throw；`TZ.run` 捕获后 `page.fail` 渲染 “Failed to load plugins”（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`，压缩单行，函数 `CZ/TZ/kZ/bZ`）。
- **证据强度**：**源码确证 + 动态确证**（附录 A-2）。
- **修复**：从 `client/client.js:1148` 删除 `'settingsScope'`；同时处理 `client/client.js:1121-1133`（见 P1-2 的替代实现）。**最小验证**：仅删服务名即可恢复 boot + 主面板（附录 A-3 已实测）。

### P1（部分功能退化：设置/模型选择/项目跟随）

#### P1-1 Host `settings.installSection` 已移除 → 模型路由设置永久失效（静默）
- **现象**：设置里的 provider/model 永远无法通过插件配置；Quick Chat 总是回退到 `agentDefaultModel`（或注册路由第一个 provider 的第一模型）。
- **证据**：插件 `lib/index.js:32-41` 调用 `settingsCtx.settings.installSection(...)`；0.2.1-rc.2 无该字符串（grep 307 包 + shell = 0）；`settings` 服务为 `SettingsForms`（`dsh-settings/lib/index.js:322-369`），新契约是“插件声明 volatile Config 字段 → 通用 describe/mutate 按 profile entry id 读写”（README:12,33,39）。
- **运行时行为**：该调用位于 `ctx.inject(['settings'], cb)` 创建的子 fiber。隔离实验（cordis 4.0.5，0.2.1-rc.2 同版本）复现：父 fiber state=2(ACTIVE)，子 fiber state=3(FAILED)，**父插件继续 ACTIVE，不阻断启动/路由**；未配置 logger exporter 时错误不外显 → “静默失效”（源码确证 + 推断；Lead 的宿主日志中也未见该报错）。
- **需注意**：`installSection` 的输入 schema 当前只是导出的常量 `QUICKCHAT_SETTINGS_SCHEMA`（`lib/index.js:8-11`），并未声明为插件 `Config`；旧 `setSource/onChange` 语义需改为“请求时读 volatile ref”。
- **修复**（host，`lib/index.js`）：
  ```js
  export const Config = z.object({
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
    storeRoot: z.string().default(''),      // 保留现有 config.storeRoot 入口
  })
  export function apply(ctx, config = {}) {
    const service = createQuickChatService({ ctx, storeRoot: config.storeRoot || undefined })
    // 用 volatile ref 的“请求时读取”替代旧 setSource
    service.setRouteSettings(() => ({
      provider: config.provider.get(),
      model: config.model.get(),
    }))
    // route 注册保持不变
    // 删除 installSection；如需抑制自动生成的设置页（可选，官方 plugin 均这么做）：
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }
  ```
  配置迁移：旧 `settings.yaml` 的 `dsh-quickchat:` 段不会被 0.2.1-rc.2 导入（legacy 导入只认固定映射表 `dsh-settings/lib/index.js:302-308`），新配置写在 profile patch 的 `- id: quickchat config: {provider, model}`。

#### P1-2 Client 设置卡片（模型选择）不存在 → 替代面为 `configForms` + `plugins.item`
- **现象**：即使修掉 P0，`ctx.slots.inject('settings.plugin.item', …)` 因 slot 永不存在而静默不注册，设置卡片消失；“设置 → 插件”里没有 Quick Chat 配置。
- **证据**：`settingsScope` / `settings.plugin.item` 全源码 0 处；官方插件配置页现行写法见 `dsh-client-ui-settings-web-search/lib/client.js:474,487-520`（`ctx.configForms.get(NS)` + `ctx.configForms.whileServed([...])` + `ctx.slots.inject('plugins.item', …)`），宿主页在 `dsh-client-ui-plugin-manager/lib/client.js:30-65,2672-2682,2747-2755`；`configForms` 服务实现 `dsh-client-ui-settings/lib/client.js:1270-1335,1104-1196`。
- **替代面说明**（按用途区分，别混用）：
  - **插件自己的配置页**（本项目所需）：`plugins.item`（插件管理页 “插件” 面板中的卡片 + 详情页 `view:'page'` 表单区）。官方 `ui-settings-web-search / ui-settings-shell / ui-settings-subagent / ui-settings-agent-loop` 全部如此。
  - `settings.plugins.tab`：给“设置 → 插件”分区加 tab（官方只读 inventory 用它），不是单插件配置卡片。
  - `settings.section`：设置页左侧导航的完整分区（models/general/plugins 等），重；如想同时给 Quick Chat 一个独立设置分区才用。
  - `settings.general.item`：设置→通用页里的行，不适合。
- **修复**（client，最小迁移）：
  1. `plugin.inject`（`client/client.js:1148`）：`settingsScope` → `configForms`（`remote.llm` 仅在保留 provider 目录回退时需要；`remote.session` 需要）。
  2. 删除 `client/client.js:1121-1133` 的 `ctx.inject(['settingsScope'], …)`，改为在 `registerClient` 内直接注册（`configForms` 已在 inject 中，服务可用）：
     ```js
     ctx.effect(() => ctx.configForms.whileServed(['quickchat'], () =>
       ctx.slots.inject('plugins.item', () => ctx.slots.register({
         name: 'plugins.item',
         id: 'quickchat',                  // 卡片 id；plugins.item 是 list slot，用 id 不用 key
         order: 20,
         label: () => t('settingsTitle'),  // label thunk 随 locale 变化
         locale: NS,
         inject: () => ({
           form: ctx.configForms.get('quickchat'),
           llm: ctx.remote?.llm,
           session: ctx.remote?.session,
           t,
         }),
       }, QuickChatSettingsCard))), 'dsh-quickchat: settings card')
     ```
     注意 key 用 **profile entry id**（本仓库的 `cordis.patch.yml` insert 行 `id: quickchat`），不是旧 settings 命名空间 `'dsh-quickchat'`。
  3. `QuickChatSettingsCard`（`client/client.js:922-1037`）改造：props 取 `form`；快照 `form.getSnapshot()` 形状为 `{status:'loading'|'ready'|'unavailable', value:{provider,model}, base, user, revision, writable}`（旧 `settingsScope` 快照只有 `{status,value}`）；订阅仍可包成 `useSyncExternalStore((l)=>form.subscribe(l), ()=>form.getSnapshot(), ()=>form.getSnapshot())`；写值 `form.set('provider', v)` / `form.set('model', v)`（返回 `Promise<boolean>`，带 revision 校验与冲突恢复）；删除 `scope.set` 与 `settings.revision` 旧用法（新快照也有 `revision`，可继续放依赖数组）。
  4. **模型目录只用 `session.modelCatalog()`**：`remote.llm.listModels` 不存在（C10），`client/client.js:955-983` 的回退分支应删除或改为官方 `remote.session.modelCatalog`/`listConfigurableProviders`；否则在 modelCatalog 不可用时模型下拉为空。
  5. 可选：改用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsFormModel`/`settingsTextField`（shell 静态模块表已含，可直接 require），减少自绘表单与 revision 处理；但不是必需。

#### P1-3 当前主会话识别用了已删除的 `sessions.list…current` → 浮窗打开后不跟随主会话切换
- **现象**：触发按钮通过 slot standard prop `sessionId` 拿到会话（动态确证），初始项目解析正确；但浮窗内 `QuickChatPanel` 的 effect 与 `sessions.list` 订阅回调都调用 `currentSessionContext()`（无 preferredId），其中 `sessionsSnapshot?.current` 在 0.2.1-rc.2 恒为 undefined（快照只有 `ids/byId/phase/projectionsBySession`）→ `cwd=''`，比较条件短路，主会话切换后浮窗仍绑定打开时的项目，直到重新打开。
- **证据**：插件 `client/client.js:513-534`（`current` 在 524 行）、`1039-1052`、`1135-1143`；服务快照 `dsh-api-session-controller/lib/client.js:3814-3819`。
- **官方现行约定**（可替代 `current`）：
  `Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView ?? 0) > 0)`（`dsh-client-ui-open-in-app/lib/client.js:770`、`dsh-client-ui-workspace/lib/client.js:89`），行的 `cwd` 字段可用（`dsh-client-ui-conversation/lib/client.js:19950`、`dsh-api-session-controller/lib/client.js:4155-4166`）。
- **修复**：
  ```js
  function currentSessionId(snapshot) {
    if (!snapshot) return undefined
    if (snapshot.current) return snapshot.current           // 旧宿主回退
    return Object.values(snapshot.byId || {})
      .find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id
  }
  const sessionId = preferredId || currentSessionId(sessionsSnapshot)
  ```
  另外 `shell.overlay` 是 root 作用域，standard props 提供 `useSessions/useWorkspaces` 等 hook（`dsh-cordis-client-runner/lib/client.js:5433+`）；也可让 `QuickChatPanel` 接收 `props.useSessions` 来观察主会话。`shell.overlay` 的 root 作用域没有 `sessionId` prop（`dsh-client-ui-layout/lib/client.js:313` 渲染 `{}`），不能指望它。
- **级别理由**：主流程可用（打开时正确），但“项目级”语义在会话切换后失真；若用户切换会话后继续发消息，消息仍写入打开时的项目库（不会跨项目污染，但会让人以为在 B 项目）。定 P1（边缘）/P2 均可接受，报告按 P1 处理。

#### P1-4 （随 P1-2 修复一并对齐）`remote.llm.listModels` 不存在
见 C10。若迁移时保留 `client/client.js:955-983` 的回退分支，`llm.listModels` 是 undefined → 模型下拉永远空，且不会报错（分支被 `if (!llm.listModels)` 吞掉）。修复：删除该回退，统一走 `remote.session.modelCatalog()`。

### P2（外观/次要/打包规范）

1. **标题生成退化（A9/A10）**：`chunk.type==='tool-call'` 是已不存在的类型（应为 `block-end` 且 `block.type==='tool-call'`，或直接忽略）；`maxTokens:64` 对配置了 `reasoningEffort: max` 的模型（本机 `agent-default-model` 就是 max）很可能整额被 reasoning 消耗 → finish=`max-tokens` → 放弃生成、保留本地回退标题；官方标题器用 4096 上限 + `prepareCall`。消息 source `{kind:'plugin',plugin}` 不在 0.2.1-rc.2 `MessageSourceMap`（`dsh-llm/lib/typert.host.js:475`）中，adapter 目前不读非 assistant 消息的 source（`dsh-llm-deepseek/lib/index.js:1515`）故不报错，但建议改成官方写法 `source: { kind: 'dsh-session-title-llm' }` / `createUserMessage`，并用 `ctx.llm.prepareCall(...)` + 更大 `maxTokens`（可参考 `dsh-session-title-llm/lib/index.js:155-195`）。
2. **`res.flush?.()` 名不副实（A5）**：原生 `ServerResponse` 无 `flush`；README “服务端主动 flush” 的说法不准确。功能不受影响（node 每 chunk 立即写 socket）；若要真 flush 需在 handler 里自行封装（无必要），或改掉 README 措辞。
3. **兼容范围无法表达（D3/B7）**：`package.json` 既无 `engines.dsh` 也无 `@deepseek-ai/dsh*` peerDependencies。建议二选一（官方推荐 `peerDependencies`，可多包约束）：
   ```json
   "peerDependencies": { "@deepseek-ai/dsh-settings": "^0.2.1-rc.2" }
   ```
   或 `"engines": { "dsh": "^0.2.1-rc.2" }`（注意：engines.dsh 一旦存在就“单独判定”，且 prerelease 需带范围语义）。同时把 `@deepseek-ai/schemastery` 从 `dependencies` 提升为 peerDependency（宿主 0.2.1-rc.2 内置 3.18.5，插件自带 3.18.2；迁移成 `Config` 后 schema 会交给 cordis 校验，版本漂移存在小风险）。
4. **`dsh.client.inject` 列表冗余（B3）**：列了 9 个包，但 client bundle 只 `require('react')`（静态表基线），`dsh.client.inject` 的语义是“先到位的 package row”，不是 cordis 服务依赖。保留不影响正确性（缺失会被忽略），但建议缩减到真实依赖（可留 locale/ui-conversation/layout 等提供 slot 的包以稳定时序），避免误读为服务注入。**注意别把它当服务注入**：真正的服务注入是 client.js 里 `plugin.inject`。
5. **desktop profile 未安装（D1）**：若后续要装到桌面 App（`~/.dsh/profiles/desktop`），除本报告的 P0/P1 外还需动态验证两处：Electron 渲染器加载路径下的 `/quickchat/api` 同源请求（`document.baseURI` + `sameOrigin`），以及 `dsh-desktop-host` 的 `webServer` 端口 + `authenticatedUrl` 组合（host 侧已确认使用 `ctx.webServer`，`dsh-desktop-host/lib/index.js:342`）。
6. **面板盒模型/层级**：`shell.overlay` 是 click-through 浮层，插件在 panel 上 `pointerEvents:'auto'` 是对的；`zIndex:1000` 与官方 dialog（1000/1100）同层，极端情况可能互相遮挡（P2，纯外观）。
7. **旧设置数据不迁移**：旧 `settings.yaml` 的 `dsh-quickchat` 段不会被 0.2.1-rc.2 导入（legacy 映射表固定），需在发布说明中提示用户重新在 Plugins 页选一次模型。

---

## 四、建议修复顺序（最小改动优先）

1. **P0（5 分钟，可立即验证）**：`client/client.js:1148` 从 `plugin.inject` 删除 `'settingsScope'`。
   验证：web profile 启动 → 页面不再 “Failed to load plugins” → `conversation.input.right` 出现触发按钮 → 点击出浮窗。**Lead 已实测通过**。
2. **P1-a Host 配置迁移**（`lib/index.js`）：新增 `export const Config`（`provider/model` volatile，可选保留 `storeRoot`）；`apply` 里 `service.setRouteSettings(() => ({provider: config.provider.get(), model: config.model.get()}))`；删除 `installSection`；可选 `settings.configure({auto:false}, ctx.fiber)`。
3. **P1-b Client 设置卡片迁移**（`client/client.js`）：按 P1-2 的代码片段把 `settingsScope` 块换成 `configForms` + `plugins.item`；卡片快照/写入 API 对齐 `ConfigFormController`；删除 `remote.llm.listModels` 回退。
4. **P1-c 当前会话识别**：`currentSessionContext` 增加 `retainedBy.mainView` 回退；让浮窗在会话切换时更新项目（P1-3 片段）。
5. **P2 批量清理**：标题生成参数与 source kind、`res.flush`/README 措辞、peerDependencies/engines、`dsh.client.inject` 列表、设置数据迁移说明。
6. **回归**：`node --test` 仍应全绿（现有 mock 测试），并补三条真机冒烟（web + desktop 可选）：boot 无 pending、`/quickchat/api` 200、Plugins 页出现 Quick Chat 卡片且可写 provider/model。

修复后需要真机复验的最小断言（建议写进发布 checklist）：
- 首屏无 “Failed to load plugins”，无 `web boot: … did not activate`；
- `conversation.input.right` 出现 `aria-label="打开临时对话"`；点击出现 `[data-quickchat-dialog]`；
- 发一条消息：NDJSON `meta→delta*→done` 正常渲染，刷新后 Recent chats 恢复；
- 设置 → 插件（Plugins 页）出现 Quick Chat 卡片，改 provider/model 后 `/quickchat/api` 的流式回答走新路由（Host `streamMessage` meta 事件里的 `route` 可见）。

---

## 五、未能静态判定、需动态验证的项

1. **P1-1 的日志可见性**：隔离 cordis 实验显示子 fiber FAILED 但父 fiber ACTIVE 且默认不输出错误；真实宿主里是否会在 `dsh` 日志中出现 `installSection is not a function`，需在真机抓 server 日志确认（推断：多数组合下静默）。Lead 的 `/tmp/dsh-smoke/server*.log` 未见该错误，倾向“静默”。
2. **`ctx.inject(['settingsScope'], …)` 在服务缺失时的具体行为**：cordis 语义上是“回调永不执行”（已由 patched-copy 实测 boot 恢复间接验证，但未单独断言回调未执行）。
3. **`plugins.item` 卡片对第三方插件在真实 “插件” 面板中的展示/表单写入**：需迁移后真机验证（官方只用它挂官方插件；slot 本身是通用的，但插件管理页的 “官方插件” 区域语义值得实测）。
4. **`conversation.input.right` 的 `sessionId` standard prop 在边界状态**（无会话 hero、embedded variant、subagent 会话）是否始终提供；实测只覆盖普通主会话。
5. **会话切换时项目跟随**：修 P1-3 后需要真机验证“切换主会话 → 浮窗项目切换”以及“同时打开两个窗口/多会话”场景。
6. **gzip 与流式响应**：0.2.1-rc.2 web 组合启用 gzip（`compression:gzip`），插件用 `Cache-Control: no-transform` 依赖标准 `compression` 包语义（该依赖不在 asar 源码中，未直接读到实现）。需真机核对 `/quickchat/api/.../messages` 响应头 **没有** `content-encoding: gzip` 且 NDJSON 增量到达。
7. **桌面（Electron）形态**：desktop profile 未装插件；若装，需验证 Electron 渲染器下的同源 fetch、`authenticatedUrl` 端口、以及同一 boot 审计（推断会同样 P0）。
8. **`@deepseek-ai/schemastery` 跨版本**：迁移出 `Config` 后，插件 3.18.2 生成的 schema 交给宿主 3.18.5 的 cordis `resolveConfig` 校验是否完全等价（预期兼容，未实测）。
9. **P2 标题生成**：本机默认 `reasoningEffort: max`，64 token 是否必然被 reasoning 吃满、是否 100% 退化为本地标题，需真机看 `title` 事件与最终标题。
10. **Host 路由鉴权**：`/quickchat/api` 直接注册在 webServer 上，绕开 `/api` 的 connection 鉴权（只做 Origin/Host 同源校验，缺 Origin 头时放行）。这不是 0.2.1-rc.2 的兼容问题，但升级后值得做一次安全复核（P2 建议）。

---

## 附录 A：动态验证记录（Lead 实测，本报告引用为“动态确证”）

环境：`/Applications/DeepSeek Harness.app` 的 0.2.1-rc.2 CLI；隔离 `DSH_HOME=/tmp/dsh-smoke`（复制 web profile，插件 symlink 指向本仓库）；无头 Chrome CDP 9223。产物：`/tmp/dsh-smoke/server3.log`、`chrome2.log`、`cdp2.mjs`、`cdp3.mjs`。

- **A-1 Host 半可用**：启动日志显示 quickchat 进入组合（`- id: quickchat name: dsh-quickchat`）；`GET /quickchat/api/conversations?cwd=/Users/gc/dsh-plugin-quickchat` 返回 200 + 项目 JSON。
- **A-2 P0 复现**：首屏 “Failed to load plugins”；控制台/页面文案 `web boot: 1 entry did not activate` + `dsh-quickchat: pending (waiting for service: settingsScope)`。
- **A-3 对照实验**：把插件复制到 `/tmp/dsh-smoke/plugin-patched`，只从 `client/client.js` 的 `plugin.inject` 移除 `'settingsScope'`（其余不动）→ 重启后 boot 正常；CDP 实测出现 `aria-label="打开临时对话"` 的按钮（`conversation.input.right` slot 生效），点击出现 `[data-quickchat-dialog]`，面板文本 “New chat / 项目 · default-workspace / Recent chats / 还没有对话”，无异常 → 其余 inject 服务（slots/sessions/workspaces/locale/remote/remote.llm/remote.session）在 0.2.1-rc.2 均可解析，P0 仅由 `settingsScope` 一个服务触发，且主 UI 链路可用。
- **A-4 兼容性门禁旁证**：同实例 `dshmarket@1.48.0` 因 `@deepseek-ai/dsh-settings` peer 范围不满足被 skip（`/tmp/dsh-smoke/server3.log:1`）；quickchat 未声明任何需求 → 未被门禁拦截，宿主半正常加载。
- **A-5 环境备注**：patched 副本最初放在 profile 的 node_modules 解析链之外时，host 入口报 `Cannot find package '@deepseek-ai/schemastery'`（`/tmp/dsh-smoke/server2.log:2-3`）；这是部署/依赖解析问题（插件声明了 `dependencies`），不是 0.2.1-rc.2 API 问题——正式安装请走 profile 的 `pnpm add link:...` 或把 `node_modules` 一并放置。

## 附录 B：审计口径与文件清单

- 插件侧审计文件：`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/index.d.ts`、`lib/quickchat-service.js`、`lib/route-handler.js`、`lib/http.js`、`lib/store.js`、`lib/project-domain.js`、`client/client.js`（工作树版本，1172 行）。
- DSH 侧主要依据：`dsh-host-webserver`、`dsh-llm`（含 `lib/typert.host.js`/`lib/typert.remote-client.js` 的远程暴露面）、`dsh-settings`、`dsh-agent-default-model`、`dsh-client-modules`、`dsh-client-ui-settings`（`configForms` 实现）、`dsh-client-ui-settings-web-search`（官方迁移样例）、`dsh-client-ui-plugin-manager`（`plugins.item` 消费者）、`dsh-client-ui-conversation`（`conversation.input.right`）、`dsh-client-ui-layout`（`shell.overlay`）、`dsh-client-ui-renderer`（slot 渲染/standard props）、`dsh-api-session-controller`、`dsh-api-workspace-controller`、`dsh-client-locale`、`dsh-api-gateway`、`dsh-app-boot`（兼容性门禁）、`dsh-web-frontend/dist`（Web shell 启动审计与静态模块表）。
- 说明：`/tmp/dsh-021` 是 app.asar 解包产物；Web shell 为压缩单行文件，函数名（`SZ/kZ/bZ/TZ`）为压缩后命名，仅用于定位证据。
