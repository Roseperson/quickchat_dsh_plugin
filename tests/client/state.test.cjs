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
    { current: 's1', byId: { s1: { cwd: '/repo-a/packages/ui' } } },
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

test('quick chat has no content rectangle to mirror before the shell renders one', () => {
  const plugin = loadPlugin()
  const { readConversationContentRect, quickChatPanelGeometry } = plugin.__test

  assert.equal(readConversationContentRect(), null)
  assert.equal(quickChatPanelGeometry(null, 900).top, 18)
  assert.equal(quickChatPanelGeometry(null, 900).height, 760)
  assert.equal(quickChatPanelGeometry(null, 400).top, 18)
  assert.equal(quickChatPanelGeometry(null, 400).height, 364)
})

test('floating quick chat mirrors the main conversation content height', () => {
  const plugin = loadPlugin()
  const { quickChatPanelGeometry } = plugin.__test

  assert.equal(quickChatPanelGeometry({ top: 76, height: 800 }, 900).top, 76)
  assert.equal(quickChatPanelGeometry({ top: 76, height: 800 }, 900).height, 800)
  assert.equal(quickChatPanelGeometry({ top: 76, height: 900 }, 900).height, 806)
  assert.equal(quickChatPanelGeometry({ top: 76, height: 100 }, 900).height, 320)
  assert.equal(quickChatPanelGeometry({ top: 0, height: 640 }, null).top, 0)
  assert.equal(quickChatPanelGeometry({ top: 0, height: 640 }, null).height, 640)
})

test('header actions expose a visible hover treatment', () => {
  const plugin = loadPlugin()
  const { headerActionStyle } = plugin.__test

  assert.equal(headerActionStyle(false).background, 'transparent')
  assert.equal(headerActionStyle(true).background, 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))')
  assert.equal(headerActionStyle(true).color, 'var(--dsw-alias-label-primary, #242426)')
  assert.match(headerActionStyle(false).transition, /background/)
})
