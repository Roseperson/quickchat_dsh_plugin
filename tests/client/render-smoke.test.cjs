const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPlugin() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/client.js'), 'utf8')
  let captured
  const state = { registered: [] }
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    Fragment: 'fragment',
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useMemo(factory) { return factory() },
    useRef(initial) { return { current: initial } },
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
  }
  const context = {
    window: {
      confirm: () => true,
      prompt: () => '',
      __ModuleLoader__: { load(entry) { captured = entry } },
    },
    console,
    document: { baseURI: 'http://localhost/' },
    TextDecoder,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  const plugin = captured.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module: ${id}`)
  })
  let ctx
  ctx = {
    effect(callback) { return callback() },
    locale: {
      register() {},
      bind() {
        const labels = { newChat: 'New chat', recent: 'Recent chats', placeholder: 'Message…', project: 'Project', empty: 'No chats yet', back: 'Back to recent chats', new: 'New chat', collapse: 'Collapse', open: 'Open quick chat', instant: 'Instant', send: 'Send', stop: 'Stop', voiceUnavailable: 'Voice unavailable', removeConfirm: 'Delete?', settingsTitle: 'Quick Chat model', settingsDescription: 'Choose a model', settingsProvider: 'Provider', settingsDefaultProvider: 'Use DSH default', settingsModel: 'Model', settingsDefaultModel: 'Choose a model', settingsModelsLoading: 'Loading models…', settingsModelsUnavailable: 'No models available' }
        return (key) => labels[key] || key
      },
    },
    sessions: {
      list: {
        getSnapshot() { return { current: 's1', byId: { s1: { cwd: '/repo-a' } } } },
        subscribe() { return () => {} },
      },
    },
    slots: {
      inject(slot, callback) { return callback() },
      register(options, render) {
        const injected = typeof options.inject === 'function' ? options.inject() : {}
        state.registered.push({ slot: options.name, options, render, injected })
        return () => {}
      },
    },
    inject(names, callback) {
      assert.equal(names.length, 1)
      assert.equal(names[0], 'settingsScope')
      callback(ctx)
    },
    settingsScope: {
      bind() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { provider: 'demo', model: 'demo-model' }, writable: true, revision: 1, base: {}, user: {}, mode: 'host' }
          },
          subscribe() { return () => {} },
          set() { return Promise.resolve() },
        }
      },
    },
    remote: {
      llm: {
        listProviders: async () => [{ id: 'demo', name: 'Demo' }],
        listModels: async (provider) => provider === 'demo' ? [{ id: 'demo-model', name: 'Demo model' }] : [],
      },
      session: {
        modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'demo-model', name: 'Demo model' }] }] } }),
      },
    },
  }
  plugin.apply(ctx)
  return { plugin, registered: state.registered }
}

function textContent(node, output = []) {
  if (node === null || node === undefined || node === false) return output
  if (typeof node === 'string' || typeof node === 'number') { output.push(String(node)); return output }
  if (Array.isArray(node)) { node.forEach((child) => textContent(child, output)); return output }
  if (typeof node.type === 'function') return textContent(node.type(node.props), output)
  if (node.props?.placeholder) output.push(String(node.props.placeholder))
  return textContent(node.children || [], output)
}

function buttonTexts(node, output = []) {
  if (node === null || node === undefined || node === false) return output
  if (Array.isArray(node)) { node.forEach((child) => buttonTexts(child, output)); return output }
  if (typeof node !== 'object') return output
  if (typeof node.type === 'function') return buttonTexts(node.type(node.props), output)
  if (node.type === 'button') output.push(textContent(node).join(''))
  return buttonTexts(node.children || [], output)
}

function nodesOfType(node, type, output = []) {
  if (node === null || node === undefined || node === false) return output
  if (Array.isArray(node)) { node.forEach((child) => nodesOfType(child, type, output)); return output }
  if (typeof node !== 'object') return output
  if (typeof node.type === 'function') return nodesOfType(node.type(node.props), type, output)
  if (node.type === type) output.push(node)
  return nodesOfType(node.children || [], type, output)
}

test('client registers a composer trigger and a frame-wide shell overlay', () => {
  const { plugin, registered } = loadPlugin()
  assert.deepEqual(registered.map((item) => item.slot), ['conversation.input.right', 'shell.overlay', 'settings.plugin.item'])
  assert.equal(plugin.inject.includes('remote.session'), true)
  assert.equal(registered[0].options.id, 'quickchat-trigger')
  assert.equal(registered[1].options.id, 'quickchat-panel')
  assert.equal(registered.some((item) => item.slot === 'conversation.chat.node' && item.options.key === 'turn-process'), false)
  assert.equal(registered[2].options.key, 'dsh-quickchat')
})

test('floating panel renders the empty project-scoped state', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
  })
  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const rendered = overlay.render({})
  const text = textContent(rendered)
  const panel = rendered.type(rendered.props)
  const dialog = panel.children[0]

  assert.equal(text.includes('New chat'), true)
  assert.equal(text.includes('Recent chats'), true)
  assert.equal(text.includes('Message…'), true)
  assert.equal(text.includes('Instant'), false)
  assert.equal(text.includes('⌕'), false)
  assert.equal(dialog.children[1].props.style.flex, 1)
  assert.equal(dialog.children[2].type.name, 'RecentChats')
})

test('floating panel renders only the current project recent rows and thread', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [
      { id: 'chat-a', title: 'A only', updatedAt: Date.now() },
      { id: 'chat-other', title: 'another A chat', updatedAt: Date.now() },
    ],
    currentId: null,
  })
  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const listText = textContent(overlay.render({})).join('|')
  assert.match(listText, /A only/)
  assert.match(listText, /another A chat/)

  plugin.__test.setPanelState({ currentId: 'chat-a', messages: [{ role: 'user', text: '只属于 A' }] })
  const threadText = textContent(overlay.render({})).join('|')
  assert.match(threadText, /只属于 A/)
  assert.doesNotMatch(threadText, /another A chat/)
})

test('current conversation title replaces the new-chat heading', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [{ id: 'chat-a', title: '当前问题标题', updatedAt: Date.now() }],
    currentId: 'chat-a',
    messages: [{ role: 'user', text: '问题' }],
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const text = textContent(overlay.render({})).join('|')
  assert.match(text, /当前问题标题/)
  assert.doesNotMatch(text, /New chat/)
})

test('thread keeps the back control outside the message scroller', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [{ id: 'chat-a', title: '标题', updatedAt: Date.now() }],
    currentId: 'chat-a',
    messages: Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `消息 ${index}` })),
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const panel = panelNode.type(panelNode.props)
  const dialog = panel.children[0]
  const threadNode = dialog.children[1]
  const thread = threadNode.type(threadNode.props)

  assert.equal(thread.props.style.display, 'flex')
  assert.equal(thread.props.style.flexDirection, 'column')
  assert.equal(thread.props.style.overflowY, undefined)
  assert.equal(thread.children[0].type, 'button')
  assert.equal(thread.children[0].props.style.flex, 'none')
  assert.equal(thread.children[1].props.style.overflowY, 'auto')
})

test('composer exposes only the send control after the top-right new-chat action', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
    currentId: null,
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const text = textContent(overlay.render({})).join('|')
  const buttons = buttonTexts(overlay.render({}))
  assert.doesNotMatch(text, /Instant/)
  assert.doesNotMatch(text, /⌕/)
  assert.equal(buttons.filter((label) => label === '+').length, 1)
  assert.equal(buttons.filter((label) => label === 'New chat').length, 0)
})

test('plugin settings card exposes the route controls in settings', () => {
  const { registered } = loadPlugin()
  const settings = registered.find((item) => item.slot === 'settings.plugin.item')
  const text = textContent(settings.render(settings.injected)).join('|')

  assert.match(text, /Quick Chat model|临时对话模型/)
  assert.match(text, /Provider|提供方/)
  assert.match(text, /Model|模型/)
  assert.doesNotMatch(text, /Max output tokens|最大输出 Token/)
  assert.doesNotMatch(text, /right sidebar|右侧栏/)
})

test('settings card uses provider-filtered model selection without a main-output budget control', () => {
  const { registered } = loadPlugin()
  const settings = registered.find((item) => item.slot === 'settings.plugin.item')
  assert.equal(typeof settings.injected.session.modelCatalog, 'function')
  const rendered = settings.render(settings.injected)
  const selects = nodesOfType(rendered, 'select')
  const inputs = nodesOfType(rendered, 'input')

  assert.equal(selects.length, 2)
  assert.equal(selects[1].props.value, 'demo-model')
  assert.equal(inputs.some((item) => item.props.type === 'number'), false)
})

test('quick chat header keeps only new and collapse actions', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
    currentId: null,
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const panel = panelNode.type(panelNode.props)
  const dialog = panel.children[0]
  const headerNode = dialog.children[0]
  const header = headerNode.type(headerNode.props)
  const actionGroup = header.children[1]
  const labels = actionGroup.children.map((node) => node.type(node.props).props.title)

  assert.deepEqual(labels, ['New chat', 'Collapse'])
})

test('quick chat header groups new and collapse actions on a frosted capsule', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
    currentId: null,
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const panel = panelNode.type(panelNode.props)
  const dialog = panel.children[0]
  const headerNode = dialog.children[0]
  const header = headerNode.type(headerNode.props)
  const actionGroup = header.children[1]
  const actions = actionGroup.children.map((node) => node.type(node.props))

  assert.equal(actionGroup.props.style.borderRadius, 999)
  assert.match(actionGroup.props.style.backdropFilter, /blur/)
  assert.match(actionGroup.props.style.WebkitBackdropFilter, /blur/)
  assert.deepEqual(actions.map((button) => button.props.title), ['New chat', 'Collapse'])
})

test('floating quick chat mirrors the conversation content band', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
    currentId: null,
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const panel = panelNode.type(panelNode.props)
  const dialog = panel.children[0]

  assert.equal(plugin.__test.readConversationContentRect(), null)
  assert.equal(panel.props.style.position, 'fixed')
  assert.equal(dialog.props.style.position, 'fixed')
  assert.equal(dialog.props.style.top, 18)
  assert.equal(dialog.props.style.height, 760)
  assert.equal(dialog.props.style.right, 18)
})

test('floating quick chat collapses when its backdrop is pressed', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [],
    currentId: null,
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const shell = panelNode.type(panelNode.props)

  assert.equal(shell.props.style.pointerEvents, 'auto')
  assert.equal(typeof shell.props.onMouseDown, 'function')
  shell.props.onMouseDown({ target: shell, currentTarget: shell })

  const collapsedNode = overlay.render({})
  assert.equal(collapsedNode.type(collapsedNode.props), null)
})

test('assistant message bubbles use the panel surface and theme-aware text color', () => {
  const { plugin, registered } = loadPlugin()
  plugin.__test.setPanelState({
    open: true,
    loaded: true,
    projectKey: 'project-a',
    project: { id: 'project-a', root: '/repo-a', title: 'repo-a' },
    cwd: '/repo-a',
    conversations: [{ id: 'chat-a', title: '标题', updatedAt: Date.now() }],
    currentId: 'chat-a',
    messages: [{ role: 'assistant', text: '暗色模式回复' }],
  })

  const overlay = registered.find((item) => item.slot === 'shell.overlay')
  const panelNode = overlay.render({})
  const panel = panelNode.type(panelNode.props)
  const dialog = panel.children[0]
  const threadNode = dialog.children[1]
  const thread = threadNode.type(threadNode.props)
  const messageNode = thread.children[1].children.flat().find((node) => node?.type?.name === 'MessageBubble')
  const bubble = messageNode.type(messageNode.props)
  const bubbleStyle = bubble.children[0].props.style

  assert.equal(bubbleStyle.background, 'transparent')
  assert.equal(bubbleStyle.border, 'none')
  assert.match(bubbleStyle.color, /--dsw-alias-label-primary/)
})
