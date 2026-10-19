const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../../client/client.js'), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))
const tick = () => new Promise((resolve) => setImmediate(resolve))

// 仅执行组件函数与显式刷新的 hooks，不使用真实 React、DOM 或网络。
function mockReact() {
  let active
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children }, children } },
    useState(initial) {
      const slot = active.index++
      const owner = active
      if (!(slot in owner.values)) owner.values[slot] = typeof initial === 'function' ? initial() : initial
      return [owner.values[slot], (value) => { owner.values[slot] = typeof value === 'function' ? value(owner.values[slot]) : value }]
    },
    useRef(initial) { return React.useState(() => ({ current: initial }))[0] },
    useMemo(factory, deps) {
      const slot = active.index++
      if (!same(active.values[slot]?.deps, deps)) active.values[slot] = { value: factory(), deps }
      return active.values[slot].value
    },
    useEffect(callback, deps) {
      const slot = active.index++
      if (!same(active.effects[slot]?.deps, deps)) active.effects[slot] = { callback, deps, pending: true, cleanup: active.effects[slot]?.cleanup }
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  function render(component, props, instance = { values: [], effects: [] }) {
    const previous = active
    active = instance
    instance.index = 0
    try { return component(props) } finally { active = previous }
  }
  function flushEffects(instance) {
    for (const effect of instance.effects) {
      if (!effect?.pending) continue
      effect.pending = false
      effect.cleanup?.()
      effect.cleanup = effect.callback()
    }
  }
  function cleanup(instance) { for (const effect of instance.effects) effect?.cleanup?.() }
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(render(node.type, node.props))
    return { ...node, children: expand(node.children) }
  }
  return { React, render, expand, flushEffects, cleanup }
}

function nodes(node, predicate, output = []) {
  if (Array.isArray(node)) { node.forEach((child) => nodes(child, predicate, output)); return output }
  if (!node || typeof node !== 'object') return output
  if (predicate(node)) output.push(node)
  nodes(node.children, predicate, output)
  return output
}
function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('|')
  if (node == null || node === false) return ''
  if (typeof node !== 'object') return String(node)
  return textContent(node.children)
}
const buttons = (tree) => nodes(tree, (node) => node.type === 'button')
const selects = (tree) => nodes(tree, (node) => node.type === 'select')

function loadPlugin({ unavailable = false } = {}) {
  const hooks = mockReact()
  const registered = []
  const effects = []
  const definitions = []
  const formIds = []
  const calls = []
  const retired = []
  let captured
  let currentEffect
  let locale = 'zh'
  let dictionaries
  let formState = { status: 'ready', value: { provider: 'demo', model: 'demo-model' }, writable: true, revision: 1 }
  let accepted = true
  const form = {
    getSnapshot: () => formState,
    subscribe: () => () => {},
    async set(field, value) {
      calls.push(['set', field, value])
      if (accepted) formState = { ...formState, revision: formState.revision + 1, value: { ...formState.value, [field]: value } }
      return accepted
    },
  }
  let sessions = { ids: ['s1', 's2'], phase: 'ready', projectionsBySession: {}, byId: { s1: { id: 's1', cwd: '/repo-a/src', retainedBy: {} }, s2: { id: 's2', cwd: '/repo-b', retainedBy: { mainView: 1 } } } }
  const workspaces = { items: [{ path: '/repo-a', sessionIds: ['s1'] }, { path: '/repo-b', sessionIds: ['s2'] }] }
  const context = {
    window: { confirm: () => true, prompt: () => '', __ModuleLoader__: { load(entry) { captured = entry } } },
    console, TextDecoder, AbortController, setTimeout, clearTimeout,
    async fetch(url) {
      calls.push(['fetch', url])
      const cwd = new URL(url, 'http://test/').searchParams.get('cwd')
      return { ok: true, async json() { return { project: { id: cwd, root: cwd, title: cwd }, conversations: [] } } }
    },
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return hooks.React
  })
  const disposable = (name) => () => retired.push(name)
  const ctx = {
    effect(callback, label) {
      const previous = currentEffect
      currentEffect = label
      try {
        const cleanup = callback()
        effects.push({ label, cleanup })
        return cleanup
      } finally { currentEffect = previous }
    },
    locale: {
      bind: () => (key) => dictionaries?.[locale]?.[key] || key,
      register(ns, values) { assert.equal(ns, 'dsh-quickchat'); dictionaries = values; return disposable('locale') },
    },
    sessions: { list: { getSnapshot: () => sessions, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => workspaces, subscribe: () => () => {} } },
    sidebarRightTabs: {
      register(definition) { assert.equal(currentEffect, 'dsh-quickchat: tab type'); definitions.push(definition); return disposable('type') },
    },
    sidebarRight: {},
    slots: {
      inject(name, callback) {
        assert.ok(currentEffect, 'slot 必须由 ctx.effect 持有')
        const unregister = callback()
        return () => { unregister(); retired.push(`inject:${name}`) }
      },
      register(options, component) {
        assert.ok(currentEffect)
        registered.push({ options, component, effect: currentEffect })
        return disposable(options.name)
      },
    },
    configForms: { get(id) { formIds.push(id); return unavailable ? undefined : form } },
    remote: { session: { async modelCatalog() {
      calls.push(['catalog'])
      return { ok: true, value: { groups: [
        { id: 'demo', name: 'Demo', models: [{ id: 'demo-model', name: 'Demo model' }] },
        { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other model' }] },
      ] } }
    } } },
  }
  plugin.apply(ctx)
  const t = ctx.locale.bind()
  function body(sessionId = 's1') {
    const entry = registered.find((item) => item.options.name === 'sidebar.right.pane.tab')
    const instance = { values: [], effects: [] }
    const signal = new AbortController()
    let closed = 0
    const tab = { signal: signal.signal, visible: true, actions: { close() { closed++; signal.abort() } } }
    const props = { ...entry.options.inject(sessionId), sessionId, useTabInfo: () => ({ tab }), useSessions: (select) => select(sessions), useWorkspaces: (select) => select(workspaces), t }
    const render = () => hooks.render(entry.component, props, instance)
    return { render, instance, tab, props, closed: () => closed }
  }
  return {
    plugin, hooks, registered, definitions, effects, formIds, calls, retired, body, form, t,
    language: (value) => { locale = value },
    setForm: (patch) => { formState = { ...formState, ...patch } },
    acceptWrites: (value) => { accepted = value },
    setSessions: (value) => { sessions = value },
  }
}

function controllerOf(body) { return body.render().children[0].props.controller }
function seed(body, patch = {}) {
  const controller = controllerOf(body)
  controller.store.set({ loaded: true, cwd: '/repo-a/src', projectKey: 'a', project: { id: 'a', root: '/repo-a', title: '项目 A' }, ...patch })
  return controller
}

async function settingsFixture(options) {
  const env = loadPlugin(options)
  const body = env.body()
  seed(body, { settingsOpen: true })
  const node = body.render().children[1]
  const instance = { values: [], effects: [] }
  const render = () => env.hooks.render(node.type, node.props, instance)
  render()
  env.hooks.flushEffects(instance)
  await tick()
  return { ...env, render, instance }
}

test('两段式注册页面型 tab，body/title 共用类型 id 并由 effect 清理', () => {
  const env = loadPlugin()
  const definition = env.definitions[0]
  assert.equal(env.definitions.length, 1)
  assert.equal(definition.id, 'dsh-quickchat')
  assert.equal(definition.kind, 'quickchat')
  assert.equal(definition.keepMounted, true)
  assert.equal(definition.patterns, undefined)
  assert.equal(definition.multiple, undefined)
  assert.equal(definition.title(), '临时对话')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'panel')
  assert.equal(definition.guide[0].order, 40)
  assert.equal(definition.guide[0].title(), '临时对话')
  assert.ok(definition.guide[0].description())
  assert.equal(definition.guide[0].commandId, undefined)
  assert.deepEqual(env.registered.map((entry) => entry.options.name), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  for (const entry of env.registered) {
    assert.equal(entry.options.key, definition.id)
    assert.equal(entry.options.id, undefined)
    assert.equal(entry.options.locale, 'dsh-quickchat')
  }
  env.body()
  assert.deepEqual(env.formIds, ['quickchat'])
  env.effects.toReversed().forEach((effect) => effect.cleanup())
  assert.equal(env.retired.length, 6)
})

test('服务注入对齐 0.2.1-rc.2，旧入口与旧设置面完全移除', () => {
  const { plugin } = loadPlugin()
  assert.deepEqual(plain(plugin.inject), ['slots', 'locale', 'sessions', 'workspaces', 'remote', 'remote.session', 'configForms', 'sidebarRightTabs', 'sidebarRight'])
  for (const legacy of ['settingsScope', 'settings.plugin.item', 'conversation.input.right', 'shell.overlay', 'remote.llm', 'listModels']) {
    assert.equal(plugin.inject.includes(legacy), false)
    assert.equal(source.includes(legacy), false)
  }
  assert.doesNotMatch(source, /position:\s*['"]fixed|ResizeHandle|Escape|addEventListener\(['"]pointerdown/)
})

test('manifest 保留 dependencies 并声明侧栏、设置提供方与兼容 peer', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-settings'], '^0.2.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '^3.18.5')
})

test('tab chip 和 guide 标题跟随语言，聊天标题不替代 chip 标题', () => {
  const env = loadPlugin()
  const title = env.registered.find((entry) => entry.options.name.endsWith('.title'))
  assert.equal(title.component({ t: env.t }), '临时对话')
  env.language('en')
  assert.equal(title.component({ t: env.t }), 'Quick chat')
  assert.equal(env.definitions[0].title(), 'Quick chat')
  assert.equal(env.definitions[0].guide[0].title(), 'Quick chat')
})

test('body 用自身 sessionId 解析项目，前台切换不改变后台 body 的项目', async () => {
  const env = loadPlugin()
  const body = env.body('s1')
  const controller = controllerOf(body)
  env.hooks.flushEffects(body.instance)
  await tick()
  assert.equal(controller.store.getSnapshot().cwd, '/repo-a/src')
  assert.match(env.calls.find((call) => call[0] === 'fetch')[1], /projectRoot=%2Frepo-a/)
  env.setSessions({ ids: ['s1', 's2'], phase: 'ready', projectionsBySession: {}, byId: { s1: { id: 's1', cwd: '/repo-a/src', retainedBy: {} }, s2: { id: 's2', cwd: '/changed', retainedBy: { mainView: 1 } } } })
  body.render()
  env.hooks.flushEffects(body.instance)
  assert.equal(controller.store.getSnapshot().cwd, '/repo-a/src')
  assert.equal(env.calls.filter((call) => call[0] === 'fetch').length, 1)
  env.hooks.cleanup(body.instance)
})

test('body 的 useState 仅初始化一次 controller，不同 body 不共享 controller', () => {
  const env = loadPlugin()
  const a = env.body('s1')
  const b = env.body('s2')
  const controller = seed(a, { draft: 'A 草稿', conversations: [{ id: 'a', title: 'A 对话' }] })
  assert.equal(controllerOf(a), controller)
  assert.notEqual(controllerOf(b), controller)
  assert.equal(controllerOf(b).store.getSnapshot().draft, '')
  assert.equal(controllerOf(b).store.getSnapshot().conversations.length, 0)
})

test('普通 flex body 填满 tab，消息滚动区内收且返回按钮位于滚动区外', () => {
  const env = loadPlugin()
  const body = env.body()
  seed(body, { currentId: 'chat', conversations: [{ id: 'chat', title: '当前问题标题' }], messages: [{ role: 'assistant', text: '答案' }] })
  const tree = env.hooks.expand(body.render())
  assert.equal(tree.props['data-quickchat-tab-body'], true)
  assert.equal(tree.props.style.height, '100%')
  assert.equal(tree.props.style.minHeight, 0)
  assert.equal(tree.props.style.display, 'flex')
  assert.equal(tree.props.style.position, undefined)
  assert.equal(nodes(tree, (node) => node.props.role === 'dialog').length, 0)
  const scroller = nodes(tree, (node) => node.props.style?.overflow === 'auto')[0]
  assert.match(textContent(scroller), /答案/)
  assert.doesNotMatch(textContent(scroller), /返回最近对话/)
  assert.match(textContent(tree), /当前问题标题/)
  assert.equal(buttons(tree).filter((node) => node.props['aria-label'] === '关闭临时对话').length, 1)
})

test('Header 提供新建、齿轮与 tab.actions.close；草稿跨设置切换保留', () => {
  const env = loadPlugin()
  const body = env.body()
  const controller = seed(body, { draft: '未发送的问题' })
  const tree = env.hooks.expand(body.render())
  const header = env.hooks.expand(body.render().children[0])
  assert.deepEqual(buttons(header).map((node) => node.props['aria-label']), ['新建对话', '临时对话模型', '关闭临时对话'])
  buttons(header)[1].props.onClick()
  const settingsTree = env.hooks.expand(body.render())
  assert.equal(nodes(settingsTree, (node) => node.props['data-quickchat-settings']).length, 1)
  assert.equal(nodes(settingsTree, (node) => node.type === 'textarea').length, 0)
  buttons(settingsTree).find((node) => textContent(node).includes('返回对话')).props.onClick()
  assert.equal(controller.store.getSnapshot().draft, '未发送的问题')
  assert.equal(nodes(env.hooks.expand(body.render()), (node) => node.type === 'textarea')[0].props.value, '未发送的问题')
  buttons(tree).find((node) => node.props['aria-label'] === '关闭临时对话').props.onClick()
  assert.equal(body.closed(), 1)
})

test('RecentChats 展开与 Thread 返回使用当前 controller，错误在空列表页也可见', () => {
  const env = loadPlugin()
  const body = env.body()
  const controller = seed(body, { conversations: Array.from({ length: 4 }, (_, i) => ({ id: String(i), title: `聊天 ${i}` })), error: 'projectUnavailable' })
  let tree = env.hooks.expand(body.render())
  assert.match(textContent(tree), /无法获取当前项目目录/)
  assert.doesNotMatch(textContent(tree), /聊天 3/)
  buttons(tree).find((node) => textContent(node).includes('See all')).props.onClick()
  tree = env.hooks.expand(body.render())
  assert.match(textContent(tree), /聊天 3/)
  controller.store.set({ currentId: '0' })
  tree = env.hooks.expand(body.render())
  buttons(tree).find((node) => textContent(node).includes('返回最近对话')).props.onClick()
  assert.equal(controller.store.getSnapshot().currentId, null)
})

test('模型设置从官方 catalog 按 provider 过滤，写入失败显示提示且不改已接受值', async () => {
  const env = await settingsFixture()
  let tree = env.render()
  assert.equal(selects(tree)[0].props.disabled, false)
  assert.equal(selects(tree)[1].props.value, 'demo-model')
  assert.match(textContent(selects(tree)[1]), /Demo model/)
  assert.doesNotMatch(textContent(selects(tree)[1]), /Other model/)
  assert.equal(env.calls.filter((call) => call[0] === 'catalog').length, 1)
  env.acceptWrites(false)
  await selects(tree)[1].props.onChange({ target: { value: '' } })
  tree = env.render()
  assert.match(textContent(tree), /设置未保存/)
  assert.equal(selects(tree)[1].props.value, 'demo-model')
  env.acceptWrites(true)
  await selects(tree)[0].props.onChange({ target: { value: 'other' } })
  tree = env.render()
  assert.equal(selects(tree)[0].props.value, 'other')
  assert.equal(selects(tree)[1].props.value, '')
  assert.match(textContent(selects(tree)[1]), /Other model/)
  assert.doesNotMatch(textContent(selects(tree)[1]), /Demo model/)
})

test('表单不可用或只读时禁用两个选择框并提供提示', async () => {
  const absent = await settingsFixture({ unavailable: true })
  assert.equal(selects(absent.render()).every((node) => node.props.disabled), true)
  assert.match(textContent(absent.render()), /模型设置暂不可用/)
  const env = await settingsFixture()
  for (const [patch, message] of [[{ status: 'loading' }, /加载中/], [{ status: 'unavailable' }, /暂不可用/], [{ status: 'ready', writable: false }, /只读/]]) {
    env.setForm(patch)
    const tree = env.render()
    assert.equal(selects(tree).every((node) => node.props.disabled), true)
    assert.match(textContent(tree), message)
  }
  assert.equal(env.calls.some((call) => call[0] === 'set'), false)
})

test('catalog 缺失已保存模型时保留配置，不在渲染阶段自动清空', async () => {
  const env = await settingsFixture()
  env.setForm({ value: { provider: 'missing', model: 'saved-model' }, revision: 9 })
  const tree = env.render()
  env.hooks.flushEffects(env.instance)
  assert.equal(selects(tree)[0].props.value, 'missing')
  assert.equal(selects(tree)[1].props.value, 'saved-model')
  assert.equal(env.calls.some((call) => call[0] === 'set'), false)
})

test('隐藏 keepMounted body 不清理 controller，重新显示时刷新 host 数据', () => {
  const env = loadPlugin()
  const body = env.body()
  const controller = controllerOf(body)
  let mounts = 0
  let releases = 0
  let refreshes = 0
  controller.mount = () => { mounts++; return () => releases++ }
  controller.loadProject = () => {}
  controller.refresh = () => refreshes++
  env.hooks.flushEffects(body.instance)
  body.tab.visible = false
  body.render()
  env.hooks.flushEffects(body.instance)
  assert.equal(mounts, 1)
  assert.equal(releases, 0)
  assert.equal(refreshes, 1)
  body.tab.visible = true
  body.render()
  env.hooks.flushEffects(body.instance)
  assert.equal(refreshes, 2)
  assert.equal(releases, 0)
  env.hooks.cleanup(body.instance)
  assert.equal(releases, 1)
})

test('模型目录请求失败时禁用选择并提示，不触发配置写入', async () => {
  const env = loadPlugin()
  const body = env.body()
  body.props.session = { async modelCatalog() { return { ok: false } } }
  seed(body, { settingsOpen: true })
  const node = body.render().children[1]
  const instance = { values: [], effects: [] }
  env.hooks.render(node.type, node.props, instance)
  env.hooks.flushEffects(instance)
  await tick()
  const tree = env.hooks.render(node.type, node.props, instance)
  assert.equal(selects(tree).every((item) => item.props.disabled), true)
  assert.match(textContent(tree), /暂无可用模型/)
  assert.equal(env.calls.some((call) => call[0] === 'set'), false)
})
