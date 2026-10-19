const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { TextDecoder } = require('node:util')
const vm = require('node:vm')

function loadPlugin({ requestAnimationFrame } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../client/client.js'), 'utf8')
  let captured
  const react = { createElement() {}, Fragment: 'fragment' }
  const context = {
    window: { __ModuleLoader__: { load(entry) { captured = entry } } },
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    AbortController,
    ...(requestAnimationFrame ? { requestAnimationFrame } : {}),
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  assert.equal(captured?.id, 'dsh-quickchat')
  return captured.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected module: ${id}`)
  })
}

test('project stores reset the active thread when the project changes', () => {
  const plugin = loadPlugin()
  const store = plugin.__test.createQuickChatStore({ id: 'project-a', title: 'A' })
  store.set({ currentId: 'chat-a', messages: [{ role: 'user', text: 'A' }] })

  store.setProject({ id: 'project-b', title: 'B' })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.projectKey, 'project-b')
  assert.equal(snapshot.currentId, null)
  assert.equal(JSON.stringify(snapshot.messages), '[]')
  assert.equal(snapshot.project.title, 'B')
})

test('project stores do not share conversations across project keys', () => {
  const plugin = loadPlugin()
  const a = plugin.__test.createQuickChatStore({ id: 'project-a', title: 'A' })
  const b = plugin.__test.createQuickChatStore({ id: 'project-b', title: 'B' })
  a.set({ conversations: [{ id: 'chat-a', title: 'A only' }] })

  assert.equal(JSON.stringify(b.getSnapshot().conversations), '[]')
  assert.equal(JSON.stringify(a.getSnapshot().conversations), JSON.stringify([{ id: 'chat-a', title: 'A only' }]))
})

test('session context prefers the DSH workspace root as the project domain', () => {
  const plugin = loadPlugin()
  const context = plugin.__test.projectContextForSession(
    { ids: ['s1'], byId: { s1: { id: 's1', cwd: '/repo-a/packages/ui', retainedBy: { mainView: 1 } } }, phase: 'ready', projectionsBySession: {} },
    { items: [{ workspaceId: 'w1', path: '/repo-a', sessionIds: ['s1'] }] },
  )

  assert.equal(JSON.stringify(context), JSON.stringify({
    sessionId: 's1',
    cwd: '/repo-a/packages/ui',
    projectRoot: '/repo-a',
  }))
})

test('stream adapter sends current project context and reduces NDJSON events', async () => {
  const plugin = loadPlugin()
  const calls = []
  const encoder = new TextEncoder()
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let used = false
          return {
            async read() {
              if (used) return { done: true, value: undefined }
              used = true
              return {
                done: false,
                value: encoder.encode([
                  { type: 'meta', conversation: { id: 'chat-a', title: '问题' } },
                  { type: 'reasoning', text: '思考' },
                  { type: 'delta', text: '答' },
                  { type: 'done', message: { role: 'assistant', text: '答案', status: 'ok' } },
                  { type: 'title', title: 'AI 标题' },
                ].map((item) => JSON.stringify(item)).join('\n') + '\n'),
              }
            },
          }
        },
      },
    }
  }
  const api = plugin.__test.createApiClient(fetchImpl)
  const events = []

  const result = await api.stream({ id: 'project-a', root: '/repo-a', cwd: '/repo-a/packages/ui', projectRoot: '/repo-a' }, 'chat-a', '问题', {
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.message.text, '答案')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done', 'title'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/quickchat/api/conversations/chat-a/messages')
  const requestBody = JSON.parse(calls[0].options.body)
  assert.equal(requestBody.cwd, '/repo-a/packages/ui')
  assert.equal(requestBody.projectRoot, '/repo-a')
  assert.equal(requestBody.text, '问题')
  assert.equal(requestBody.provider, undefined)
  assert.equal(requestBody.model, undefined)
})

test('stream adapter yields after each delta so buffered segments can paint separately', async () => {
  const frames = []
  const plugin = loadPlugin({
    requestAnimationFrame(callback) {
      frames.push(callback)
      return frames.length
    },
  })
  const encoder = new TextEncoder()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let used = false
        return {
          async read() {
            if (used) return { done: true, value: undefined }
            used = true
            return {
              done: false,
              value: encoder.encode([
                { type: 'meta', conversation: { id: 'chat-a', title: '问题' } },
                { type: 'delta', text: '第一段' },
                { type: 'delta', text: '第二段' },
                { type: 'done', message: { role: 'assistant', text: '第一段第二段', status: 'ok' } },
              ].map((item) => JSON.stringify(item)).join('\n') + '\n'),
            }
          },
        }
      },
    },
  })
  const api = plugin.__test.createApiClient(fetchImpl)
  const events = []
  const pending = api.stream({ id: 'project-a', root: '/repo-a' }, 'chat-a', '问题', {
    onEvent: (event) => events.push(event),
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta'])
  assert.equal(frames.length, 1)

  frames.shift()()
  assert.equal(frames.length, 1)
  frames.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'delta'])
  assert.equal(frames.length, 1)

  frames.shift()()
  assert.equal(frames.length, 1)
  frames.shift()()
  const result = await pending
  assert.equal(result.message.text, '第一段第二段')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'delta', 'done'])
})

test('client message projection strips legacy reasoning before rendering', () => {
  const plugin = loadPlugin()
  assert.equal(JSON.stringify(plugin.__test.visibleMessages([
    { role: 'assistant', text: '答案', reasoning: '隐藏' },
    { role: 'user', text: '问题' },
  ])), JSON.stringify([
    { role: 'assistant', text: '答案' },
    { role: 'user', text: '问题' },
  ]))
})

test('native DSH model catalog is projected into provider-scoped model options', () => {
  const plugin = loadPlugin()
  const projection = plugin.__test.modelCatalogProjection({
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
    ],
  })

  assert.equal(JSON.stringify(projection.providers), JSON.stringify([
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'openai', name: 'OpenAI' },
  ]))
  assert.equal(JSON.stringify(projection.modelsByProvider.deepseek), JSON.stringify([{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]))
  assert.equal(JSON.stringify(projection.modelsByProvider.openai), JSON.stringify([{ id: 'gpt', name: 'GPT' }]))
})

test('composer keeps IME confirmation Enter out of submission', () => {
  const plugin = loadPlugin()
  const { isComposingEvent, shouldSubmitOnEnter } = plugin.__test

  assert.equal(isComposingEvent({ key: 'Enter', isComposing: true }), true)
  assert.equal(isComposingEvent({ key: 'Enter', keyCode: 229 }), true)
  assert.equal(isComposingEvent({ key: 'Enter', which: 229 }), true)
  assert.equal(isComposingEvent({ key: 'Enter' }, () => true), true)
  assert.equal(isComposingEvent({ key: 'Enter' }, () => false), false)

  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 }), false)
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false)
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }), false)
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false }), true)
})

test('header actions expose a visible hover treatment', () => {
  const plugin = loadPlugin()
  const { headerActionStyle } = plugin.__test

  assert.equal(headerActionStyle(false).background, 'transparent')
  assert.equal(headerActionStyle(true).background, 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))')
  assert.equal(headerActionStyle(true).color, 'var(--dsw-alias-label-primary, #242426)')
  assert.match(headerActionStyle(false).transition, /background/)
})

const plain = (value) => JSON.parse(JSON.stringify(value))
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function mockApi(overrides = {}) {
  let serial = 0
  const conversations = []
  const project = { id: 'project-a', root: '/repo-a', title: 'A' }
  return {
    async list() { return { project, conversations: structuredClone(conversations) } },
    async create() {
      const conversation = { id: `chat-${++serial}`, title: '' }
      conversations.unshift(conversation)
      return { project, conversation: { ...conversation } }
    },
    async messages() { return { messages: [] } },
    async rename(_project, id, title) { return { conversation: { id, title } } },
    async remove() {},
    async cancel() {},
    async stream() { return { message: { role: 'assistant', text: '答案', status: 'ok' } } },
    ...overrides,
  }
}
const projectContext = { sessionId: 's1', cwd: '/repo-a/src', projectRoot: '/repo-a' }

async function controllerWith(api = mockApi()) {
  const controller = loadPlugin().__test.createQuickChatTabController({ api })
  await controller.loadProject(projectContext)
  return controller
}

test('项目解析优先使用 body 的 sessionId，忽略前台会话和旧 current 字段', () => {
  const { projectContextForSession } = loadPlugin().__test
  const sessions = {
    current: 'legacy',
    ids: ['a', 'b'], phase: 'ready', projectionsBySession: {},
    byId: { a: { id: 'a', cwd: '/a', retainedBy: { mainView: 1 } }, b: { id: 'b', cwd: '/b/src', retainedBy: {} } },
  }
  const workspaces = { items: [{ path: '/b', sessionIds: ['b'] }] }
  assert.deepEqual(plain(projectContextForSession(sessions, workspaces, 'b')), { sessionId: 'b', cwd: '/b/src', projectRoot: '/b' })
  assert.equal(projectContextForSession(sessions, workspaces).sessionId, 'a')
  assert.equal(projectContextForSession(sessions, workspaces, 'missing').cwd, '')
  assert.equal(projectContextForSession({ current: 'legacy', byId: {} }, {}).sessionId, undefined)
  assert.equal(projectContextForSession({ byId: { b: { id: 'b' } } }, workspaces, 'b').cwd, '/b')
})

test('同项目两个 controller 共享 host 数据，但选择、草稿、设置视图和 store 各自独立', async () => {
  const api = mockApi()
  const a = await controllerWith(api)
  const b = await controllerWith(api)
  let bChanges = 0
  b.store.subscribe(() => bChanges++)
  a.store.set({ draft: 'A 草稿', settingsOpen: true, expanded: true })
  await a.createConversation()
  assert.notEqual(a.store, b.store)
  assert.equal(bChanges, 0)
  assert.equal(b.store.getSnapshot().currentId, null)
  assert.equal(b.store.getSnapshot().draft, '')
  assert.equal(b.store.getSnapshot().settingsOpen, false)
  assert.equal(b.store.getSnapshot().expanded, false)
  await b.refresh()
  assert.equal(b.store.getSnapshot().conversations[0].id, a.store.getSnapshot().currentId)
  assert.equal(b.store.getSnapshot().currentId, null)
  assert.equal(a.store.getSnapshot().draft, 'A 草稿')
})

test('流式合并 meta、delta、done 与延迟 title，过滤 reasoning 且不重复落消息', async () => {
  const wire = deferred()
  let emit
  const controller = await controllerWith(mockApi({ stream(_p, _id, _text, options) { emit = options.onEvent; return wire.promise } }))
  await controller.createConversation()
  const sending = controller.sendMessage('问题')
  emit({ type: 'meta', conversation: { title: '本地标题', messageCount: 1 } })
  emit({ type: 'reasoning', text: '隐藏' })
  emit({ type: 'delta', text: '答' })
  emit({ type: 'delta', text: '案' })
  assert.equal(controller.store.getSnapshot().partial, '答案')
  emit({ type: 'done', message: { role: 'assistant', text: '答案', reasoning: '隐藏', status: 'ok' } })
  assert.equal(controller.store.getSnapshot().streaming, true)
  assert.equal(await controller.sendMessage('重复发送'), false)
  emit({ type: 'title', title: '自动标题' })
  wire.resolve({ message: { role: 'assistant', text: '答案' } })
  await sending
  const state = controller.store.getSnapshot()
  assert.equal(state.streaming, false)
  assert.equal(state.partial, '')
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1].reasoning, undefined)
  assert.equal(state.conversations[0].title, '自动标题')
})

test('停止仅取消当前 body 的活跃请求，并保存部分回答', async () => {
  const pending = []
  const cancelled = []
  const api = mockApi({
    stream(project, id, _text, options) {
      const wire = deferred()
      options.signal.addEventListener('abort', () => wire.reject(Object.assign(new Error('停止'), { name: 'AbortError' })), { once: true })
      pending.push({ id, options, wire })
      return wire.promise
    },
    async cancel(project, id) { cancelled.push({ project, id }) },
  })
  const a = await controllerWith(api)
  const b = await controllerWith(api)
  await a.createConversation()
  await b.createConversation()
  b.stopMessage()
  assert.equal(cancelled.length, 0)
  const first = a.sendMessage('A')
  const second = b.sendMessage('B')
  pending[0].options.onEvent({ type: 'delta', text: '未完成' })
  a.stopMessage()
  a.stopMessage()
  await first
  assert.equal(pending[0].options.signal.aborted, true)
  assert.equal(pending[1].options.signal.aborted, false)
  assert.equal(b.store.getSnapshot().streaming, true)
  assert.equal(a.store.getSnapshot().messages[1].status, 'aborted')
  assert.equal(a.store.getSnapshot().messages[1].text, '未完成')
  assert.equal(a.store.getSnapshot().error, '')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].id, pending[0].id)
  pending[1].wire.resolve({ message: { role: 'assistant', text: 'B 答案' } })
  await second
})

test('关闭 tab 的 signal 取消请求；卸载后的事件和响应不能写回', async () => {
  const wire = deferred()
  let options
  const api = mockApi({ stream(_p, _id, _text, opts) { options = opts; return wire.promise } })
  const controller = await controllerWith(api)
  await controller.createConversation()
  const tab = new AbortController()
  const release = controller.mount(tab.signal)
  const sending = controller.sendMessage('问题')
  tab.abort()
  const snapshot = controller.store.getSnapshot()
  assert.equal(options.signal.aborted, true)
  options.onEvent({ type: 'delta', text: '迟到的内容' })
  wire.resolve({ message: { role: 'assistant', text: '迟到的回答' } })
  await sending
  assert.equal(controller.store.getSnapshot(), snapshot)
  assert.equal(await controller.sendMessage('已关闭'), false)
  release()
})

test('切换项目取消旧流式，晚到的旧响应不会污染新项目', async () => {
  const wire = deferred()
  let options
  const controller = await controllerWith(mockApi({
    async list(ctx) { return { project: { id: ctx.projectRoot, root: ctx.projectRoot }, conversations: [] } },
    stream(_p, _id, _text, opts) { options = opts; return wire.promise },
  }))
  await controller.createConversation()
  const sending = controller.sendMessage('旧项目')
  await controller.loadProject({ sessionId: 's2', cwd: '/b', projectRoot: '/b' })
  assert.equal(options.signal.aborted, true)
  options.onEvent({ type: 'title', title: '旧标题' })
  options.onEvent({ type: 'delta', text: '旧回答' })
  wire.resolve({ message: { text: '旧回答' } })
  await sending
  const state = controller.store.getSnapshot()
  assert.equal(state.projectKey, '/b')
  assert.equal(state.currentId, null)
  assert.equal(state.messages.length, 0)
  assert.equal(state.streaming, false)
})

test('项目列表与消息读取按代次隔离，先发后到的请求被丢弃', async () => {
  const oldList = deferred()
  const threads = { a: deferred(), b: deferred() }
  const controller = loadPlugin().__test.createQuickChatTabController({ api: mockApi({
    list(ctx) { return ctx.cwd === '/old' ? oldList.promise : Promise.resolve({ project: { id: 'new', root: '/new' }, conversations: [] }) },
    messages(_p, id) { return threads[id].promise },
  }) })
  const old = controller.loadProject({ cwd: '/old' })
  await controller.loadProject({ cwd: '/new' })
  oldList.resolve({ project: { id: 'old', root: '/old' }, conversations: [{ id: 'old-chat' }] })
  await old
  assert.equal(controller.store.getSnapshot().projectKey, 'new')
  const a = controller.selectConversation('a')
  const b = controller.selectConversation('b')
  threads.b.resolve({ messages: [{ text: 'B' }] })
  await b
  threads.a.resolve({ messages: [{ text: 'A' }] })
  await a
  assert.equal(controller.store.getSnapshot().currentId, 'b')
  assert.equal(controller.store.getSnapshot().messages[0].text, 'B')
})

test('创建期间阻止重复发送，创建失败恢复草稿并展示错误', async () => {
  const creating = deferred()
  let calls = 0
  const controller = await controllerWith(mockApi({ create() { calls++; return creating.promise } }))
  controller.store.set({ draft: '问题' })
  const first = controller.sendMessage('问题')
  assert.equal(controller.store.getSnapshot().streaming, true)
  assert.equal(await controller.sendMessage('重复'), false)
  assert.equal(await controller.createConversation(), null)
  creating.reject(new Error('创建失败'))
  await first
  assert.equal(calls, 1)
  assert.equal(controller.store.getSnapshot().draft, '问题')
  assert.equal(controller.store.getSnapshot().error, '创建失败')
  assert.equal(controller.store.getSnapshot().streaming, false)
})

test('重命名与删除保留其他会话，空标题不发请求', async () => {
  const controller = await controllerWith()
  const first = await controller.createConversation()
  const second = await controller.createConversation()
  await controller.renameConversation(first.id, '  修改标题  ')
  await controller.renameConversation(second.id, '   ')
  assert.equal(controller.store.getSnapshot().conversations.find((item) => item.id === first.id).title, '修改标题')
  assert.equal(controller.store.getSnapshot().conversations.find((item) => item.id === second.id).title, '')
  await controller.removeConversation(second.id)
  assert.equal(controller.store.getSnapshot().currentId, null)
  assert.deepEqual(plain(controller.store.getSnapshot().conversations.map((item) => item.id)), [first.id])
})

test('项目目录不可用时明确降级，不发送 host 请求', async () => {
  let calls = 0
  const controller = loadPlugin().__test.createQuickChatTabController({ api: mockApi({ async list() { calls++ } }) })
  await controller.loadProject({ sessionId: 'missing', cwd: '' })
  assert.equal(controller.store.getSnapshot().error, 'projectUnavailable')
  assert.equal(await controller.sendMessage('问题'), false)
  assert.equal(calls, 0)
})

test('表单不可用、加载中、只读或写入被拒绝时返回 false', async () => {
  const { settingsSnapshot, settingsNotice, updateQuickChatSetting } = loadPlugin().__test
  assert.equal(settingsNotice(settingsSnapshot(undefined)), 'settingsUnavailable')
  for (const snapshot of [{ status: 'loading' }, { status: 'unavailable', writable: true }, { status: 'ready', writable: false }]) {
    const form = { getSnapshot: () => snapshot, set() { assert.fail('不应写入') } }
    assert.equal(await updateQuickChatSetting(form, 'model', 'm'), false)
  }
  for (const set of [async () => false, async () => { throw new Error('断开连接') }]) {
    assert.equal(await updateQuickChatSetting({ getSnapshot: () => ({ status: 'ready', writable: true }), set }, 'model', 'm'), false)
  }
})

test('切换 provider 串行清理旧 model，遵循表单返回的接受结果与 revision', async () => {
  const { updateQuickChatSetting } = loadPlugin().__test
  let state = { status: 'ready', writable: true, revision: 5, value: { provider: 'a', model: 'a-model' } }
  const calls = []
  const form = {
    getSnapshot: () => state,
    async set(field, value) {
      calls.push([field, value, state.revision])
      state = { ...state, revision: state.revision + 1, value: { ...state.value, [field]: value } }
      return true
    },
  }
  assert.equal(await updateQuickChatSetting(form, 'provider', 'b'), true)
  assert.deepEqual(calls, [['model', '', 5], ['provider', 'b', 6]])
  assert.equal(state.value.model, '')
  assert.equal(await updateQuickChatSetting(form, 'model', 'b-model'), true)
  assert.equal(await updateQuickChatSetting(form, 'unknown', ''), false)
  form.set = async () => false
  assert.equal(await updateQuickChatSetting(form, 'provider', 'c'), false)
  assert.equal(state.value.provider, 'b')
})

test('模型目录只消费 session.modelCatalog，拒绝失败或畸形结果', async () => {
  const { loadModelCatalog } = loadPlugin().__test
  const catalog = await loadModelCatalog({ modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] } }) })
  assert.equal(catalog.modelsByProvider.p[0].id, 'm')
  for (const result of [{ ok: false }, {}, { groups: null }]) {
    await assert.rejects(loadModelCatalog({ modelCatalog: async () => result }))
  }
  await assert.rejects(loadModelCatalog(undefined))
})

test('创建对话期间停止发送会保留草稿，不启动流式请求', async () => {
  const creating = deferred()
  let streams = 0
  const controller = await controllerWith(mockApi({
    create: () => creating.promise,
    async stream() { streams++ },
  }))
  const sending = controller.sendMessage('还未发送')
  controller.stopMessage()
  creating.resolve({ conversation: { id: 'empty-chat', title: '' } })
  await sending
  assert.equal(streams, 0)
  assert.equal(controller.store.getSnapshot().draft, '还未发送')
  assert.equal(controller.store.getSnapshot().streaming, false)
})

test('done 后关闭仍中止等待标题的响应，保留完整回答且不再调用 host cancel', async () => {
  const wire = deferred()
  let options
  let cancels = 0
  const controller = await controllerWith(mockApi({
    stream(_p, _id, _text, opts) {
      options = opts
      opts.signal.addEventListener('abort', () => wire.reject(Object.assign(new Error('停止'), { name: 'AbortError' })), { once: true })
      return wire.promise
    },
    async cancel() { cancels++ },
  }))
  await controller.createConversation()
  const sending = controller.sendMessage('问题')
  options.onEvent({ type: 'done', message: { role: 'assistant', text: '完整回答' } })
  controller.stopMessage()
  await sending
  assert.equal(options.signal.aborted, true)
  assert.equal(controller.store.getSnapshot().messages.length, 2)
  assert.equal(controller.store.getSnapshot().messages[1].text, '完整回答')
  assert.equal(cancels, 0)
})

test('controller 生命周期允许 effect 清理后重新挂载，旧加载不会重新写入', async () => {
  const loading = deferred()
  let reads = 0
  const controller = loadPlugin().__test.createQuickChatTabController({ api: mockApi({
    list() {
      reads++
      return reads === 1 ? loading.promise : Promise.resolve({ project: { id: 'new', root: '/repo-a' }, conversations: [] })
    },
  }) })
  const tab = new AbortController()
  const cleanup = controller.mount(tab.signal)
  const old = controller.loadProject(projectContext)
  cleanup()
  const release = controller.mount(tab.signal)
  await controller.loadProject(projectContext)
  loading.resolve({ project: { id: 'old', root: '/old' }, conversations: [] })
  await old
  assert.equal(controller.store.getSnapshot().projectKey, 'new')
  release()
})
