# dsh-quickchat

DSH 原生右侧栏中的项目级持久化临时对话 tab，要求 DSH v0.2.1-rc.2 及以上兼容版本。

## 功能

- 先打开一个 DSH 主会话，再展开原生右侧栏，从 guide 页选择「临时对话 / Quick chat」；已有 tab 时点击 tab strip 的「+」进入 guide。这是唯一打开入口，无独立浮窗或主输入区外挂按钮；无 session 的首页没有右侧栏入口。
- 使用 `sidebarRightTabs` 注册页面型 tab，并通过原生 body/title seat 渲染；尺寸、布局与 tab 关闭由 DSH 右侧栏管理。
- `keepMounted: true` 保留已打开的 body：切换 tab、切换 session 或收起侧栏时，草稿和进行中的请求继续保留；关闭 tab 或卸载插件时清理请求。
- 每个 tab body 按自身 `sessionId` 解析项目，独立保存当前对话、草稿和流式状态；同项目的多个 session 共享持久化聊天数据，重新显示时刷新列表。草稿不承诺跨页面刷新保留。
- 面板含当前对话标题、`Recent chats`、消息与输入框；header 的「+ / 齿轮 / ×」分别新建对话、打开模型设置、关闭 tab。配色跟随 DSH 主题。
- 使用 `ctx.llm.stream` 做无工具、无 AgentLoop 的轻量问答；主请求不额外注入 Quick Chat system prompt 或输出 token 上限。
- 支持增量流式输出、停止生成、创建、重命名、删除、刷新后重新读取已保存对话，以及首条消息的最佳努力自动标题；reasoning 不进入 Quick Chat 的事件、持久化消息或界面。
- Quick Chats 按项目隔离，不进入 DSH 主会话历史。
- 输入框遵循 DSH 的 IME 判定：中文输入法仍在组词/选词时，Enter 不会发送；Shift+Enter 换行。

## 项目域

Host 优先使用客户端从 DSH workspace 投影带来的 `projectRoot`，并校验它确实包含当前 `cwd`；没有明确项目根时使用最近的 Git root，非 Git 目录使用规范化后的当前目录。

```text
$DSH_HOME/quickchat/projects/<sha256(canonical-project-root)>/
├── project.json
├── index.json
└── chats/
    └── <chat-id>.jsonl
```

没有跨项目 Recent chats 接口。每次读写都会重新解析当前项目，并校验 chat id 属于该项目。

## 安装

需要 **DSH v0.2.1-rc.2+**，且 profile 启用原生右侧栏、会话与设置服务。`peerDependencies` 中的 `@deepseek-ai/dsh-settings: ^0.2.1-rc.2` 供 DSH 兼容性门禁检查；实际可用版本须满足该范围，不能据此假定所有未来版本都兼容。插件依赖 `@deepseek-ai/schemastery: ^3.18.5`，以支持 volatile 配置。

在目标 DSH profile 的 `cordis.patch.yml` 中加入包 patch，或将 patch 内容合入 profile 层：

```yaml
- insert:
    - id: quickchat
      name: dsh-quickchat
```

开发时可以将本包链接到 profile：

```sh
pnpm add link:/absolute/path/to/dsh-plugin-quickchat
```

本地开发先在仓库根运行 `npm install --no-audit --no-fund`。安装内容必须包含 `client/client.js`，DSH Web client module 会直接加载这个 lazy-CJS bundle。

## 模型设置

点击 Quick Chat **header 齿轮**打开 tab 内的模型设置，选择提供方和模型；返回对话时保留草稿。两项留空则跟随 DSH 的 `agentDefaultModel`。模型目录来自 `remote.session.modelCatalog()`；表单加载中、不可用或只读时显示状态并禁用相应控件。

Host 使用 0.2.1-rc.2 的 `export const Config`（`provider` / `model` 为 volatile string）与 `settings.configure({ auto: false }, ctx.fiber)`；客户端通过 `configForms.get('quickchat')` 读写。也可在 profile 的 `cordis.patch.yml` 中为现有行设置普通字符串：

```yaml
- id: quickchat
  config:
    provider: '' # 留空跟随默认；指定时填写已注册的提供方 ID
    model: ''    # 指定时填写对应模型 ID
```

旧 `settings.yaml` 的 `dsh-quickchat` 段不会自动迁移，请通过齿轮或上述 profile 配置重新设置。主回答沿用 DSH 默认调用参数，不提供专属最大输出 Token 或 system prompt 设置；凭据仍由 DSH 管理，本插件不保存密钥。

## HTTP API

所有接口都以当前项目为域：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/quickchat/api/conversations?cwd=&projectRoot=` | 当前项目列表 |
| POST | `/quickchat/api/conversations` | 新建会话（body 携带 `cwd`，可选 `projectRoot`） |
| PATCH | `/quickchat/api/conversations/:id` | 重命名 |
| DELETE | `/quickchat/api/conversations/:id` | 删除会话和消息文件 |
| GET | `/quickchat/api/conversations/:id/messages?cwd=&projectRoot=` | 读取消息 |
| POST | `/quickchat/api/conversations/:id/messages` | 发送消息并返回 NDJSON 流 |
| POST | `/quickchat/api/conversations/:id/cancel` | 停止生成 |

流事件顺序为 `meta`、零个或多个 `delta`、可选 `error`、`done`，以及可能在 `done` 之后到达的 `title`。HTTP 层使用 NDJSON、`no-transform` 和逐事件写出；浏览器在非空 `delta` 后让出绘制机会，显示粒度取决于 provider 实际产生的 delta。主回答完成后，标题请求采用同一 provider/model、独立提示词与 **4096 token** 辅助预算；标题失败、超时、取消或用户已重命名时保留本地回退标题。标题预算不影响主回答。

## 开发与测试

```sh
node --test
# 或
npm test
```

测试覆盖项目根解析、项目隔离、原子索引、JSONL 恢复、Host 流式服务、HTTP 路由、标题总结、volatile 配置、内联模型设置、lazy-CJS bundle、原生 tab 注册、每个 body 的状态隔离、生命周期与 IME。真实宿主验证见 [动态验证记录](docs/dynamic-verification-0.2.1-rc.2.md)。

## 范围

当前版本作为原生右侧栏 tab 使用，不创建 Electron 窗口、不注册全局快捷键，也不实现语音输入、附件和自动全项目上下文注入；主会话及多栏布局由 DSH 管理。
