# dsh-quickchat × DSH v0.2.1-rc.2 动态验证记录

> 时间：2026-10-19 · 执行者：Lead（Agent Team）
> 目的：在**隔离环境**中对用户正在运行的 DSH 0.2.1-rc.2 做真机冒烟，验证静态审计结论；全程不修改仓库源码、不触碰用户运行中的桌面 App / `~/.dsh` 配置。
> 环境：macOS · DeepSeek Harness.app 0.2.1-rc.2（`app.asar/dsh`，`@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.2`）· 隔离 `DSH_HOME=/tmp/dsh-smoke`（复制 `~/.dsh/profiles/web`，仅将 `node_modules/dsh-quickchat` 指向本仓库；后续对照实验指向临时副本）· 无头 Chrome (CDP 9223) 打开 Web UI。

## 结论速览

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| Host 插件进入 profile 组合配置 | ✅ 通过 | `dsh --profile web --dump-config` 输出含 `- id: quickchat` / `name: dsh-quickchat` |
| Host HTTP API（GET / POST / 真实 LLM 流式） | ✅ 完整可用 | 见 §2；真实模型返回 `meta → delta("OK") → done` |
| Client 插件装载（bundle 进入 boot graph） | ✅ 通过 | boot graph 含 `dsh-quickchat/client.js`，combo bundle 200 且内容为插件源码 |
| Client 插件**激活**（原仓库代码） | ❌ **P0 失败** | 整页 "Failed to load plugins"；`dsh-quickchat: pending (waiting for service: settingsScope)` |
| Client 插件激活（仅移除 `settingsScope` 的临时副本） | ✅ 通过 | 触发按钮渲染，点击浮窗打开，项目解析 `default-workspace`，无报错 |
| 设置卡片（模型选择） | ⚠️ 失效（P1） | 0.2.1-rc.2 无 `settings.plugin.item` / `settingsScope`；需迁移新 API（见兼容性报告） |

## 1. 环境与步骤

```sh
# 1) 隔离 home：复制 web profile（插件 symlink 指向本仓库），改用绝对路径 symlink
rm -rf /tmp/dsh-smoke && mkdir -p /tmp/dsh-smoke/profiles
cp -a ~/.dsh/profiles/web /tmp/dsh-smoke/profiles/web
ln -sfn /Users/gc/dsh-plugin-quickchat /tmp/dsh-smoke/profiles/web/node_modules/dsh-quickchat

# 2) 用 App 自带 0.2.1-rc.2 CLI 启动隔离 web 实例（不打开浏览器）
DSH_HOME=/tmp/dsh-smoke \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --profile web --no-open --port 0
# → dsh web: http://127.0.0.1:<port>/?token=<token>

# 3) 无头 Chrome + CDP 打开页面，读取 DOM / console / boot 状态
#    （Node 内建 WebSocket 连 http://127.0.0.1:9223/json/list）
```

启动参数说明：`--port 0` 由系统分配端口，不会与用户桌面 App 的 `127.0.0.1:55943` 冲突；`--no-open` 不拉起浏览器；`DSH_HOME` 指向 /tmp 副本，不写用户数据。

## 2. Host 半：完整可用（含真实模型流式）

### 2.1 API 基础

```
GET  /quickchat/api/conversations?cwd=/Users/gc/dsh-plugin-quickchat
→ 200 {"project":{"id":"7a6b0c02...","title":"dsh-plugin-quickchat","root":"/Users/gc/dsh-plugin-quickchat"},"conversations":[]}
```

### 2.2 真实 LLM 端到端（把 `~/.dsh/.credentials.yaml` 复制进隔离 home 后）

```
POST /quickchat/api/conversations            {"cwd": "...", "projectRoot": "...", "title": "compat-test"}
→ 200 conversation.id = b3259498-…

POST /quickchat/api/conversations/b3259498-…/messages   {"cwd":"...","text":"只回复两个字：OK"}
→ NDJSON:
{"type":"meta","conversation":{"id":"b3259498-…","title":"compat-test","messageCount":1},
 "route":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"},"dropped":0}
{"type":"delta","text":"OK"}
{"type":"done","message":{"role":"assistant","text":"OK","ts":1792372465549,"model":"deepseek-flash","status":"ok"},"aborted":false}
```

说明：
- `ctx.llm.stream` 参数（`provider/model/messages/signal`）与 0.2.1-rc.2 的 `GenerateOptions` 兼容，adapter 正常消费插件构造的 durable-style messages。
- `ctx.agentDefaultModel.currentSelection()` 可用：meta 中 route 即来自 profile 的 `agent-default-model` 配置（`deepseek-official/deepseek-flash` + `reasoningEffort: max`）。
- `ctx.llm.resolveCallConfig` 路由校验可用。
- `ctx.webServer.register({kind:'prefix', …})` 与 NDJSON/`no-transform` 流式响应在 0.2.1-rc.2 正常工作。
- 本次未触发标题摘要（创建时已带 title，`shouldSummarizeTitle=false`）；标题路径仅静态核对（`system`/`maxTokens` 仍被 adapter 接受，`purpose` 为未知字段被忽略）。

## 3. Client 半：原仓库代码在 0.2.1-rc.2 下 P0 不激活

无头 Chrome 打开隔离实例后：

```
document.body.innerText →
  "HARNESS\nFailed to load plugins\nweb boot: 1 entry did not activate\ndsh-quickchat: pending (waiting for service: settingsScope)"

Runtime.consoleAPICalled →
  error: "web boot: 1 entry did not activate
          dsh-quickchat: pending (waiting for service: settingsScope)"
```

DOM 中不存在 quickchat 触发按钮（`aria-label="打开临时对话"` 数量 0），用户可见后果 = **插件在 0.2.1-rc.2 WebUI 中完全不出现**。
原因：`client/client.js` 的 `plugin.inject` 声明了 0.2.1-rc.2 已不存在的 `settingsScope` 服务；cordis 因缺失服务让整个 client 插件保持 pending（host 半不受影响）。

## 4. 对照实验：仅移除 `settingsScope` 后功能恢复

把仓库复制到 `/tmp/dsh-smoke/plugin-patched`（`node_modules` symlink 回仓库），**只**把 `plugin.inject` 里的 `'settingsScope'` 删除，其余不动，重启隔离实例：

```
触发按钮: 存在，aria-label="打开临时对话"（slot conversation.input.right 正常）
点击后:   document.querySelector('[data-quickchat-dialog]') → dialog-open
面板文本: "New chat / 项目 · default-workspace / Recent chats / 还没有对话 / ↑"
项目解析: 成功（host 返回 project 标题/default-workspace）
控制台:   无 quickchat 相关错误
```

→ 证明 P0 是单点问题；移除后 `slots` / `sessions` / `workspaces` / `locale` / `remote` / `shell.overlay` / `conversation.input.right` 等 UI 链路在 0.2.1-rc.2 均可用。

## 5. 环境旁证（与被测插件无关，但影响用户的 web profile）

隔离实例启动日志复现了用户 `~/.dsh/profiles/web` 的既有问题：

1. `dsh: skipping profile bundle "dshmarket": … requirements {"@deepseek-ai/dsh-settings":"^0.1.x"}` —— dshmarket 1.48.0 与 0.2.1-rc.2 不兼容被 DSH 主动跳过（0.2.1-rc.2 新增 plugin 兼容性门禁，读 `peerDependencies`/`engines.dsh`）。
2. `patch: name mismatch for "llm-deepseek" (expected "@deepseek-ai/dsh-llm-deepseek-api-key", got "@deepseek-ai/dsh-llm-deepseek"), skipping` —— web profile 的 `llm-deepseek` patch 未生效。

这两条与 quickchat 无直接关系，但说明该 web profile 在 0.2.1-rc.2 下本身不是干净状态。

## 6. 局限与未覆盖

1. 只在 **web profile** 验证；用户实际运行的桌面 GUI 用 `~/.dsh/profiles/desktop`，且该 profile **未安装** dsh-quickchat（见兼容性报告）。
2. 设置卡片/模型选择 UI 未做运行时验证：原代码的 `settings.plugin.item` slot 在 0.2.1-rc.2 不存在，实验副本删除 `settingsScope` 后该卡片也不会注册（符合预期，属待迁移功能）。
3. 标题摘要路径未真机触发（避免额外请求）；仅静态核对。
4. 未测试多 session / 长会话裁剪 / 附件等边界；不影响兼容性主结论。
5. 实验在 `/tmp` 的插件副本上进行，仓库源码未作任何修改。

## 7. 复现提示

- 若测试实例已退出，按 §1 重启；端口以日志中 `dsh web:` 行为准。
- Chrome CDP：`--headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/...`，用 `/json/list` 找 target，`Runtime.evaluate` 取 DOM；也可直接 `curl` 走 HTTP API（需先 `curl -L -c jar "<token URL>"` 取得 cookie）。
- 目录 `/tmp/dsh-021/dsh/node_modules/@deepseek-ai/` 是 0.2.1-rc.2 `app.asar` 的解包源码，可用于核对任何 file:line 证据。

## 修复后复验（2026-10-19）

本节验证当前仓库的原生右侧栏 tab 实现；前文 §2–§6 是旧浮窗版本的历史记录，不代表修复后的状态。本轮未提交 Git、未启动桌面 GUI，测试仅通过 App 自带 CLI 的 `ELECTRON_RUN_AS_NODE` 路径与无头 Chrome 执行。

### 依赖、代码与测试

- `package.json` 的 `@deepseek-ai/schemastery` 从 `^3.18.2` 升为 `^3.18.5`；保留既有 `peerDependencies` 等其他字段。
- 仓库根执行 `npm install --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000`，成功从 npm registry 安装，新增 `package-lock.json`；**未使用本地 vendoring**。`npm ls @deepseek-ai/schemastery --depth=0` 显示 `3.18.5`；`node -e "import('@deepseek-ai/schemastery').then(z=>console.log(typeof z.default.string().default('').volatile))"` 输出 `function`。
- 依赖升级后 Host 入口恢复通过；剩余失败为 `tests/client/render-smoke.test.cjs` 对旧范围 `^3.18.2` 的硬编码断言，已更新为 `^3.18.5`。
- 发现 tab 根节点原有 `data-quickchat-mode="tab"`，缺少验收约定的 `data-quickchat-tab-body`；在 `client/client.js` 补充该属性，并在既有 body 渲染测试中检查。没有重写 tab 架构，也没有额外修改 Host 实现。
- 最终 `node --test`：**81 tests / 81 pass / 0 fail / 0 skipped**（72 个顶层测试，含子测试）；证据 `/tmp/dsh-verify/tests-final.log:492–495`。`git diff --check` 通过。
- README 更新为原生 guide/「+」入口、每个 body 独立状态、`keepMounted`、header 齿轮内联表单、volatile `Config` / `settings.configure`、profile provider/model 配置、兼容性门禁及 4096 token 标题预算；删除旧浮窗、旧设置位置与主动 flush 等过时描述。

### 隔离实例与启动证据

新建此前不存在的 `/tmp/dsh-verify`（权限 0700），复制 `~/.dsh/profiles/web` 和 `.credentials.yaml`；复制后的 `node_modules/dsh-quickchat` symlink 指向 `/Users/gc/dsh-plugin-quickchat`，凭据文件权限设为 0600。沿用复制 profile 的默认工作区 `/Users/gc/Documents/deepseek-harness/default-workspace`；Quick Chat 数据仍写入隔离 `$DSH_HOME/quickchat`。

```sh
DSH_HOME=/tmp/dsh-verify \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --profile web --no-open --port 0

DSH_HOME=/tmp/dsh-verify \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --profile web --dump-config

# token 仅留在隔离目录，不在报告中展示
curl -sS -L -c /tmp/dsh-verify/cookies.txt '<token URL>' \
  -o /tmp/dsh-verify/boot.html

'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/dsh-verify/chrome \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 \
  --window-size=1440,1000 about:blank
```

运行时地址为 `http://127.0.0.1:60373/`，server PID `42679`，Chrome PID `42725`。Node `v22.23.2` 内建 WebSocket 连接 CDP；脚本及 JSON/PNG 证据保存在 `/tmp/dsh-verify/`。

| 断言 | 结果 | 本轮证据 |
| --- | --- | --- |
| 4.3a：Host 启动无 quickchat 导入/激活错误，配置包含插件 | **通过** | `server.log:2` 输出监听 URL；全文无 quickchat `did not activate`、导入错误或 `.volatile is not a function`；`dump-config.yaml:1298` 为 `- id: quickchat`，下一行为 `name: dsh-quickchat`，dump 命令退出 0 |
| 4.3b：认证 HTML 与 boot graph | **通过** | curl 先跟随 token URL 并保存 cookie；`boot.html:24` 包含 `plugins/??dsh-quickchat/client.js&rev=4b9d0d3988a2`；HTML 和浏览器均无 `Failed to load plugins`（`http-evidence.json`、`01-boot.json`） |
| 4.3c：项目 API | **通过** | `GET http://127.0.0.1:60373/quickchat/api/conversations?cwd=/Users/gc/dsh-plugin-quickchat` → HTTP 200 JSON；project.root 为仓库，conversations 为 `[]`（`api-headers.txt:1`、`api-conversations.json`） |
| 4.4a：页面无插件失败；hero 无 session/右侧栏不存在 | **启动通过，严格的无 session 前提未复现** | hero 无展开侧栏、Quick Chat body 数为 0；但宿主已自动准备空白 `session-009da776-11d9-445f-8fc0-49fe8b000ef2`，DOM 有该 session 的收起 surface 和原生展开按钮，因此不能断言“无 session / surface 不存在”（`02-before.json`、`03-session.json:4`、`01-hero.png`） |
| 4.4b：hero 提交短消息进入会话 | **通过** | 在首次预览说明中点击「继续」，通过 `[data-composer-input="true"]` 输入 `hi`，确认发送按钮 enabled 后提交；实际模型提交 **1 次**，hero 随后消失，主会话最终完成（`03-session.json:2–17`、`03-session.png`） |
| 4.4c：打开 DSH 原生右侧栏 | **通过** | 按 `[data-slot="conversation.session.header.corner"] [data-sidebar-right-expand]` 定位并点击，未依赖固定按钮文案；出现 `[data-sidebar-right-open]` 与 guide（`04-tab.json:2`、`04-guide.png`） |
| 4.4d：原生 guide / tab strip「+」打开 Quick Chat | **通过** | guide 中存在 `[data-sidebar-right-guide-entry="quickchat"]`，文本「临时对话」；点击后 `[data-quickchat-tab-body]` 数量为 1、mode 为 `tab`；localStorage 布局含 `kind:"quickchat"` / `contentId:"sidebar://quickchat"`（`04-tab.json:6–39`、`04-tab.png`） |
| 4.4e：header 齿轮内联设置 | **通过，未写 provider/model** | `[data-quickchat-settings]` 数量为 1；provider 控件 `disabled:false`，目录含 `deepseek-official`、`deepseek-account`、`soulclaude`、`soulgpt`；provider/model 值均为 `""`，未指定 provider 时 model 控件按设计禁用；无加载、只读或错误提示（`04-tab.json:42`、`04-settings.png`） |
| 4.4f（可选）：tab 内真实流式 | **UI 增量、完成与持久化通过** | Quick Chat 实际提交 `hi` **1 次**；DOM 先显示 `Hi! How can`，再显示完整 `Hi! How can I help you today?`，最终停止按钮消失、标题更新为 `Casual greeting to start session`；GET messages 为 200，assistant 为 `status:"ok"`（`05-stream.json:15`、`06-confirm.json`、`07-persistence.json:17`、`06-complete.png`） |
| 补充：guide 切换时 keepMounted 与项目隔离 | **通过所测范围** | 草稿 `hi` → 点击原生 `[data-dockkit-add-tab]` → guide 中 body 仍为 1 → 点击 quickchat entry 返回，草稿仍为 `hi`（`05-stream.json:8`）；默认工作区产生一条聊天后，仓库域列表仍为空（`07-persistence.json`） |
| 关闭测试进程及端口 | **通过** | 仅向本轮创建的 Chrome/server 进程组发送 SIGTERM；`60373`、`9223` 均已关闭（`cleanup.json:12`） |

### 异常、限制与收尾

- **未把 hero 等同于无 session**：复制的 profile/宿主会准备空白 session。上述严格前提与实际观测不符，未为了获得预期结果修改宿主或 profile；“完全 sessionless hero”行为仍需单独场景确认，不影响本轮原生入口与设置主链验证。
- CDP 辅助脚本最初遇到导航期间 `document.body` 尚未存在、把 DOM 节点当 JSON 返回，以及字符串转义错误；改为就绪等待、布尔条件和读取 label 子节点后完成验证。tab 再次显示时刷新列表会短暂禁用发送按钮，等待 enabled 后再提交；没有因此重复调用模型。
- `05-stream.json` 的原始 `completed:false` 是脚本要求取得完整 CDP Network/NDJSON 结果的标志；该网络分支未收齐，**不代表 UI 流式失败**。本轮通过带时间的 DOM 增量样本、最终按钮状态与只读 GET messages 独立确认 UI 流式完成及保存；不宣称已抓到本次完整 `meta → delta → done` 网络事件序列。没有为补抓网络再发模型请求。
- 既有环境提示：启动时仍跳过不兼容的 `dshmarket@1.48.0`；浏览器有 git-graph 提示 `workspaces` 服务形状变化、auto-isolation disabled。均未阻止 Quick Chat。本轮未修其他插件。
- 仅打开并读取模型设置，未调用 provider/model 的写入；复制 profile 唯一差异为点击首次说明后更新 `welcomeNoticeVersion`。未验证真实设置写入、完整双 session 切换、取消长响应或 Electron 渲染器；这些不计为真机通过项。
- 真实 `~/.dsh` 的 56 个配置相关文件建立了内容/mtime 指纹：55 个未变化，真实 profile 配置与凭据均未变化。唯一例外为既有运行时用量文件 `~/.dsh/.dshw-usage.json` 在观察期间更新，来源未确认；本轮未对它执行写入或回滚，不能宣称整个真实目录逐字节不变（`cleanup.json:16`）。测试进程均显式使用隔离 `DSH_HOME`。
- Git HEAD 与开始时相同，未创建 commit。除本文件外，`docs/` 其他文件指纹均未变化。本轮修改 `README.md`、`package.json`、`client/client.js`、`tests/client/render-smoke.test.cjs` 和本文件，新增 npm 生成的 `package-lock.json`；其余工作树改动为接手时已有。
- 收尾 `git status --short --untracked-files=all`：修改项为 `README.md`、`client/client.js`、`lib/index.d.ts`、`lib/index.js`、`lib/quickchat-service.js`、`package.json`、`tests/client/render-smoke.test.cjs`、`tests/client/state.test.cjs`、`tests/host/plugin-entry.test.js`、`tests/host/quickchat-service.test.js`；未跟踪项为三份既有 `docs/*.md` 与新增 `package-lock.json`。`git diff --stat`：**10 files changed, 1430 insertions(+), 939 deletions(-)**（不含未跟踪文档和 lockfile）。

**结论**：schemastery 启动阻塞已解除；81 项测试全绿；真实 WebUI 的原生 guide/「+」入口、tab body、可读且可用的模型设置、增量回复及持久化均已验证。严格的 sessionless hero 前提未复现，其余未覆盖范围如上，不将历史浮窗证据或单元测试替代为本轮真机结论。

## desktop profile 验证（2026-10-19）

本轮按用户授权安装到真实 `~/.dsh/profiles/desktop`，再以该 profile 的完整副本做隔离验收，作为 `0.2.0` 发版门禁。与前述 web profile 记录不同，本轮真实安装已完成；**没有停止、重启或连接操作正在承载用户会话的桌面 GUI**。开始与收尾的 `lsof` 均显示原 PID `26428` 持续监听 `127.0.0.1:55943`。

### 真实 profile 安装与只读组合

- 修改前创建并核对内容一致的备份：`~/.dsh/profiles/desktop/package.json.bak-20261019-quickchat`、`~/.dsh/profiles/desktop/pnpm-lock.yaml.bak-20261019-quickchat`。
- 使用 App 自带 CLI 执行 `DSH_HOME=/Users/gc/.dsh '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' plugin --profile desktop add link:/Users/gc/dsh-plugin-quickchat`，退出 0；由 App 内置 `pnpm 11.28.5` 完成，无需手工安装回退。
- `package.json` 与备份的结构化比较严格相等于两项预期改动：dependencies 新增 `"dsh-quickchat": "link:/Users/gc/dsh-plugin-quickchat"`，`dsh.profile.bundles` 末尾追加 `"dsh-quickchat"`。原 bundle 顺序不变，Quick Chat 位于 `dsh-web-app` 等基础 bundle 之后。
- lockfile diff 仅新增 Quick Chat importer；`node_modules/dsh-quickchat` 的相对软链接实际解析到 `/Users/gc/dsh-plugin-quickchat`。安装输出含 linked peer dependency 提示，但后续真实 runtime 组合、激活、UI 与 API 均通过。
- **指定的 `--profile desktop --dump-config` 原命令退出 1**，错误为 `profile "desktop" is managed exclusively by the Electron application`。这是 App CLI 对保留 profile 名的限制，不能将原命令记为成功。
- 补验使用同一 App 内置 runtime 的 `readProfileManifest`、`resolveBundleDir`、兼容性检查、`bundlePatchPaths`、`loadOverlayPatches` 与 `renderConfigDump`，只读真实 profile、包 patch 和 home patch。未调用会改写 root config 的 `prepareProfile`，也未调用 `boot` / `runProfile`。脚本 `/tmp/dsh-desktop-verify/read-only-dump.mjs` 退出 0；`/tmp/desktop-dump.yaml:1387–1388` 包含 `- id: quickchat` / `name: dsh-quickchat`，无跳过 bundle、无 Quick Chat 错误。
- 组合仅提示既有 `dsh-side-chat-plus` patch 找不到对应 entry；本轮不修改其他插件。真实 `cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 和 `.credentials.yaml` 内容指纹均未变化。
- 安装证据：`/tmp/dsh-desktop-verify/install.log`、`installation.json`、`package.json.diff`、`pnpm-lock.yaml.diff`、`desktop-dump.stderr`。

### 隔离方式与启动

新建权限 `0700` 的 `/tmp/dsh-desktop-verify`，执行 `cp -a ~/.dsh/profiles/desktop /tmp/dsh-desktop-verify/profiles/desktop`，将副本的 Quick Chat 软链接改为仓库绝对路径，并复制 `.credentials.yaml`、设置权限 `0600`。未复制真实会话、存储或其他凭据文件。

隔离环境直接以 `--profile desktop --no-open --port 0` 启动同样受到保留名限制，退出 1。按允许的回退方案，将副本另复制为 `profiles/desktop-verify`，仅将其 `package.json.name` 改为 `dsh-profile-desktop-verify`；**依赖、bundle 内容及顺序保持不变**。隔离 CLI 的 `--profile desktop-verify --dump-config` 退出 0；去掉来源注释和空行后，与真实 profile 的只读组合输出完全一致。

```sh
DSH_HOME=/tmp/dsh-desktop-verify \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --profile desktop-verify --no-open --port 0
```

本轮监听地址 `http://127.0.0.1:61862/`，server PID `45267`；无头 Chrome PID `45302`，CDP `127.0.0.1:9223`，用户目录 `/tmp/dsh-desktop-verify/chrome`。使用 Node `v22.23.2` 内建 WebSocket 驱动 CDP。token 不写入本文或 Git；测试数据仅写入隔离 `DSH_HOME`。主会话沿用 profile 的默认工作区 `/Users/gc/Documents/deepseek-harness/default-workspace`。

### 验收结果

下表中的 JSON、日志、脚本和截图均位于 `/tmp/dsh-desktop-verify/`，最终自动断言为 `07-acceptance.json` 的 `allRequiredPassed: true`。

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| a. Host 导入与激活 | **通过** | `server.log:2` 输出测试监听地址；运行及收尾日志无 Quick Chat import/activate 错误，无 `did not activate`；`dump-config.yaml` 包含插件 |
| b. token 认证页面与 boot graph | **通过** | `curl -L -c` 获取页面为 200；`boot.html:24` 含 `dsh-quickchat/client.js`；HTML 和实际浏览器均无 `Failed to load plugins`（`http-evidence.json`、`01-boot.json`） |
| c. 仓库项目 API | **通过** | `GET /quickchat/api/conversations?cwd=/Users/gc/dsh-plugin-quickchat` → 200，project.root 为仓库，列表为空（`api-headers.txt:1`、`api-conversations.json`） |
| d. hero 输入进入主会话 | **通过** | 关闭首次预览说明后实际提交 `hi` **1 次**，无需重试；hero 消失，主会话成功完成（`03-session.json`、`04-settings.png`） |
| d. 原生右侧栏与 guide 入口 | **通过** | 点击 `[data-slot="conversation.session.header.corner"] [data-sidebar-right-expand]`，guide 出现「临时对话」；点击后 `[data-quickchat-tab-body]` 数量为 1，mode 为 `tab`（`04-tab.json`、`04-guide.png`、`04-tab.png`） |
| d. 齿轮设置表单 | **通过，仅只读检查** | provider 控件 `disabled:false`，目录包含 `deepseek-official` / `deepseek-account`；provider/model 均为 `""`，model 因未选 provider 按设计禁用，无错误或只读提示；**未修改 provider/model**（`04-tab.json`、`04-settings.png`） |
| 可选：Quick Chat 流式与持久化 | **通过** | tab 内提交 `hi` **1 次**；DOM 采样依次显示 `Hi!`、`Hi! How can I help you today`、完整回复，停止按钮最终消失；GET messages 为 200，assistant `status:"ok"`，并与隔离 JSONL 内容一致（`05-stream.json`、`06-confirm.json`、`07-acceptance.json`、`07-complete.png`） |
| 补充：「+」guide 与项目隔离 | **通过所测范围** | 点击原生 `[data-dockkit-add-tab]` 后 Quick Chat body 仍挂载，返回后草稿 `hi` 保留；默认工作区有 1 条聊天，仓库项目仍为 0 条（`05-stream.json`、`07-acceptance.json`） |
| e. 关闭测试 server / Chrome | **通过** | 核对进程命令和记录的 PID/进程组后，仅对本轮两个测试进程组发送 SIGTERM；`61862`、`9223` 均关闭，原 GUI PID `26428` / `55943` 仍在（`cleanup.json`） |

### 限制、异常与发版门禁

- 本轮**未发现需要修复的插件实现 bug**；没有修改 client、lib 或 tests。安装前 `node --test` 为 **81/81**，日志 `/tmp/dsh-quickchat-preinstall-tests.log`。
- `05-stream` 辅助脚本因未收齐 CDP 的完整 NDJSON 响应体而退出 1，其 `completed:false` 仅表示该网络采集未完成。保留该原始证据，不宣称捕获完整网络事件序列；随后 `07-acceptance.mjs` 独立断言已有 DOM 增量、最终 UI 状态、只读 GET messages 和隔离 JSONL 内容，退出 0，**没有再次发送模型请求**。
- 宿主在 hero 阶段已准备空 session，因此本轮不声称验证了严格的 sessionless 首页。未启动或验证 Electron 渲染器；真实 GUI 中的插件效果需用户自行重启 App 后确认。未验证 provider/model 写入、取消长响应或完整双 session 切换。
- 既有环境输出包括 Electron `task_name_for_pid` 提示及其他 UI 的 AudioContext / Canvas 警告；均未阻止本轮必需断言，不作为 Quick Chat 错误。
- 副本启动后的 profile patch 唯一新增为首次说明的 `welcomeNoticeVersion`，没有 provider/model 写入。真实 profile 除已记录的安装文件及 profile 内包管理器记录外未由本轮修改；真实凭据与其他上述配置指纹保持一致。测试副本的 `.credentials.yaml`、token 文件及 curl cookie jar 已在收尾删除。
- 本轮只在本文件末尾追加 docs；另两份既有 docs 内容指纹保持不变。全部必需验收与清理通过后，将包及 npm lockfile 的根版本同步为 `0.2.0`，补充 repository 元数据；README 已是原生右栏说明且无 `0.1.0` 字样，仓库无 CHANGELOG，因此不新建。最终提交前再次执行 `node --test` 和 `git diff --check`，结果记入下方发版检查。

### 发版检查

- `0.2.0` 元数据更新后的 `node --test`：**81 tests / 81 pass / 0 fail / 0 skipped**，退出 0；日志 `/tmp/dsh-desktop-verify/tests-release.log`。
- `git diff --check`：退出 0；package.json、package-lock.json 顶层及根包版本均为 `0.2.0`，其他 docs 指纹不变。
- 发版采用 Git commit、annotated tag `v0.2.0` 与 origin push；不执行 `npm publish`。GitHub CLI 已登录时，在 push 成功后创建同名 GitHub Release。具体 commit / push / Release 结果以本次任务最终汇报及远端记录为准。
