# dsh-quickchat

DSH WebUI 内的项目级持久化临时对话面板。

## 功能

- 从 DSH WebUI 底部输入区打开 Quick Chat；面板始终是右下角的固定浮窗，不接管主会话布局，也不注册或替换 DSH 原生右侧栏。
- 浮窗高度与主会话内容区（`[data-conversation-scroll]`，含转录区与输入区）一致，并随窗口尺寸和内容区尺寸变化实时重算；没有会话内容时回退到有界的浮窗高度。
- 标题右侧的操作组固定为 `+ → −`，使用毛玻璃胶囊背景；assistant 回复使用透明面板背景并跟随 DSH 深色主题文字色。
- 视觉上参考 Codex Quick Chat：当前会话标题、`Recent chats`、线程消息和胶囊输入框。
- 使用 `ctx.llm.stream` 做无工具、无 AgentLoop 的轻量问答；主请求不额外注入 Quick Chat system prompt 或输出 token 上限。
- 支持真正的增量流式输出、停止生成、创建、重命名、删除、刷新后恢复，以及首条消息的最佳努力自动标题；服务端关闭代理变换并主动 flush，每个客户端 delta 都让出一次浏览器绘制机会；reasoning 不进入 Quick Chat 的事件、持久化消息或界面。
- Quick Chats 按项目隔离，不进入 DSH 主会话历史。
- 只保留标题栏右上角的 `+` 作为新建入口；右上角 `+`、`−` 有 hover/focus 反馈；线程返回按钮位于消息滚动区之外。
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

启动前确保当前 DSH 版本已安装本包的 `client/client.js`，因为 DSH Web client module 会加载已发布的 bundle。

## 模型设置

打开 DSH 的「设置 → 插件 → 插件配置」，在「临时对话模型」卡片中选择提供方，再从该提供方返回的模型列表中选择模型。两项都留空时，Quick Chat 读取 DSH 的 `agentDefaultModel`；没有该服务时才使用已注册路由的兼容性回退。主回答沿用 DSH 的默认调用参数，不提供 Quick Chat 专属的最大输出 Token 或 system prompt 设置；凭据仍由 DSH 的模型/凭据设置管理，本插件不保存密钥。

DSH 自带右侧栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）由官方维护，本插件不再注册右侧栏形态，也不读写它的 tab 注册表；浮窗位置与高度只跟随主会话内容区，与原生右栏是否展开无关。

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

流事件顺序为 `meta`、零个或多个 `delta`、可选 `error`、`done`，以及可能在 `done` 之后到达的 `title`。HTTP 层使用 NDJSON、`no-transform` 和逐事件 flush，浏览器消费层在每个非空 `delta` 后等待下一次绘制，因此不会等到整个回答完成后再一次性渲染；显示粒度取决于 DSH provider 实际产生的 delta。主回答完成后，标题请求使用 DSH 原生标题策略的语义异步执行：采用同一 provider/model、独立的标题提示词与 64 token 辅助预算；标题失败、超时、取消或用户已重命名时保留本地回退标题。标题辅助预算不影响主回答。

## 开发与测试

```sh
node --test
```

测试覆盖项目根解析、项目隔离、原子索引、JSONL 恢复、Host 流式服务、HTTP 路由、标题总结、模型设置、lazy-CJS bundle、slot 注册、IME、浮窗内容区高度换算和主要 UI 状态。

## 范围

当前版本不创建 Electron 窗口、不注册全局快捷键、不实现语音输入、附件和自动全项目上下文注入，也不接入 DSH 原生右侧栏、不做多栏布局接管。
