/*
 * dsh-quickchat WebUI client.
 *
 * This file is intentionally a lazy-CJS bundle: DSH's client-module host
 * registers the factory during boot and materializes React only when the
 * plugin row is activated.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quickchat',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useState = React.useState
    const useSyncExternalStore = React.useSyncExternalStore

    const NS = 'dsh-quickchat'
    const SETTINGS_NAMESPACE = 'dsh-quickchat'
    const ROUTE = '/quickchat/api'
    const MAX_DRAFT = 32000
    const QUICKCHAT_PANEL_MARGIN = 18
    const QUICKCHAT_PANEL_MIN_HEIGHT = 320
    const QUICKCHAT_PANEL_MAX_HEIGHT = 760
    const QUICKCHAT_CONTENT_SELECTOR = '[data-conversation-scroll]'

    const dictionaries = {
      zh: {
        quickChat: '临时对话',
        newChat: 'New chat',
        recent: 'Recent chats',
        placeholder: 'Message…',
        send: '发送',
        stop: '停止',
        new: '新建对话',
        collapse: '收起',
        open: '打开临时对话',
        seeAll: 'See all',
        seeLess: '收起列表',
        loading: '加载中…',
        empty: '还没有对话',
        emptyThread: '输入问题，开始一段临时对话',
        rename: '重命名',
        remove: '删除',
        renamePrompt: '输入新的对话标题',
        removeConfirm: '删除这个对话？对话内容将一并删除。',
        projectUnavailable: '无法获取当前项目目录',
        requestFailed: '请求失败，请重试',
        project: '项目',
        back: '返回最近对话',
        settingsTitle: '临时对话模型',
        settingsDescription: '选择临时对话使用的提供方和模型；留空则跟随 DSH 默认路由。',
        settingsProvider: '提供方',
        settingsModel: '模型',
        settingsDefaultModel: '请选择模型',
        settingsModelsLoading: '模型加载中…',
        settingsModelsUnavailable: '暂无可用模型',
        settingsDefaultProvider: '跟随 DSH 默认',
        settingsUnavailable: '设置服务暂不可用',
        trajectoryThinking: '生成中…',
        trajectoryThought: '轨迹',
      },
      en: {
        quickChat: 'Quick chat',
        newChat: 'New chat',
        recent: 'Recent chats',
        placeholder: 'Message…',
        send: 'Send',
        stop: 'Stop',
        new: 'New chat',
        collapse: 'Collapse',
        open: 'Open quick chat',
        seeAll: 'See all',
        seeLess: 'Show less',
        loading: 'Loading…',
        empty: 'No chats yet',
        emptyThread: 'Ask a question to start a temporary chat',
        rename: 'Rename',
        remove: 'Delete',
        renamePrompt: 'Enter a new chat title',
        removeConfirm: 'Delete this chat? Its messages will be removed too.',
        projectUnavailable: 'The current project directory is unavailable',
        requestFailed: 'Request failed. Try again.',
        project: 'Project',
        back: 'Back to recent chats',
        settingsTitle: 'Quick Chat model',
        settingsDescription: 'Choose the provider and model for Quick Chat; leave them empty to follow the DSH default route.',
        settingsProvider: 'Provider',
        settingsModel: 'Model',
        settingsDefaultModel: 'Choose a model',
        settingsModelsLoading: 'Loading models…',
        settingsModelsUnavailable: 'No models available',
        settingsDefaultProvider: 'Use DSH default',
        settingsUnavailable: 'Settings service is unavailable',
        trajectoryThinking: 'Tracing…',
        trajectoryThought: 'Trace',
      },
    }

    const colors = {
      panel: 'var(--dsw-alias-bg-base, #ffffff)',
      elevated: 'var(--dsw-alias-bg-elevated, #ffffff)',
      text: 'var(--dsw-alias-label-primary, #242426)',
      secondary: 'var(--dsw-alias-label-secondary, #737376)',
      tertiary: 'var(--dsw-alias-label-tertiary, #9a9a9d)',
      border: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))',
      accent: 'var(--dsw-alias-state-business-primary, #6e6ee8)',
      accentSoft: 'var(--dsw-alias-state-business-primary-soft, rgba(110, 110, 232, 0.14))',
    }

    /**
     * The main conversation's content well: the scroll body that owns the
     * transcript and the composer. The floating Quick Chat panel mirrors this
     * rectangle, so it stands exactly as tall as the session content beside it.
     */
    function readConversationContentRect() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      const element = document.querySelector(QUICKCHAT_CONTENT_SELECTOR)
      const rect = element?.getBoundingClientRect?.()
      const measured = rect?.height
      const height = Number.isFinite(measured) && measured > 0 ? measured : element?.clientHeight
      if (!Number.isFinite(height) || height <= 0) return null
      const top = Number.isFinite(rect?.top) ? rect.top : QUICKCHAT_PANEL_MARGIN
      return { top: Math.round(Math.max(0, top)), height: Math.round(height) }
    }

    /**
     * Resolve the panel's vertical band from the measured content rectangle.
     * Falls back to the previous bounded floating height while the shell has no
     * conversation on screen (hero, no session) and clamps to the viewport so a
     * short window never pushes the panel past the bottom edge.
     */
    function quickChatPanelGeometry(contentRect, viewportHeight) {
      const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.round(viewportHeight) : null
      const maxHeight = viewport === null ? null : Math.max(QUICKCHAT_PANEL_MIN_HEIGHT, viewport - QUICKCHAT_PANEL_MARGIN * 2)
      const measured = contentRect && Number.isFinite(contentRect.height) && contentRect.height > 0 ? Math.round(contentRect.height) : null
      if (measured === null) {
        const fallback = maxHeight === null ? QUICKCHAT_PANEL_MAX_HEIGHT : Math.min(QUICKCHAT_PANEL_MAX_HEIGHT, maxHeight)
        return { top: QUICKCHAT_PANEL_MARGIN, height: fallback }
      }
      const top = Number.isFinite(contentRect.top) ? Math.round(Math.max(0, contentRect.top)) : QUICKCHAT_PANEL_MARGIN
      const room = viewport === null ? measured : Math.max(QUICKCHAT_PANEL_MIN_HEIGHT, viewport - top - QUICKCHAT_PANEL_MARGIN)
      return { top, height: Math.max(QUICKCHAT_PANEL_MIN_HEIGHT, Math.min(measured, room)) }
    }

    function headerActionStyle(hovered, style = {}) {
      return {
        ...style,
        background: hovered ? colors.hover : (style.background || 'transparent'),
        color: hovered ? colors.text : (style.color || colors.secondary),
        transition: 'background 140ms ease, color 140ms ease, transform 140ms ease',
        transform: hovered ? 'scale(1.04)' : 'scale(1)',
      }
    }

    const EMPTY_SETTINGS_SNAPSHOT = { status: 'ready', value: { provider: '', model: '' } }
    const noopSubscribe = () => () => {}
    const emptySettingsSnapshot = () => EMPTY_SETTINGS_SNAPSHOT

    function useQuickChatSettings() {
      const scope = quickChatSettingsScope
      const subscribe = scope?.subscribe ? (listener) => scope.subscribe(listener) : noopSubscribe
      const getSnapshot = scope?.getSnapshot ? () => scope.getSnapshot() : emptySettingsSnapshot
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function useQuickChatPanelGeometry() {
      const [geometry, setGeometry] = useState(() => quickChatPanelGeometry(
        readConversationContentRect(),
        typeof window === 'undefined' ? null : window.innerHeight,
      ))
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let observed = null
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null
        function refresh() {
          setGeometry(quickChatPanelGeometry(
            readConversationContentRect(),
            typeof window === 'undefined' ? null : window.innerHeight,
          ))
          const element = typeof document.querySelector === 'function' ? document.querySelector(QUICKCHAT_CONTENT_SELECTOR) : null
          if (!resizeObserver || !element || element === observed) return
          if (observed) resizeObserver.unobserve(observed)
          observed = element
          resizeObserver.observe(element)
        }
        refresh()
        window.addEventListener?.('resize', refresh)
        return () => {
          resizeObserver?.disconnect()
          window.removeEventListener?.('resize', refresh)
        }
      }, [])
      return geometry
    }

    function blankProject() {
      return { id: '', root: '', title: '' }
    }

    function initialState(project) {
      const value = project || blankProject()
      return {
        open: false,
        loaded: false,
        loading: false,
        projectKey: value.id || '',
        project: value,
        cwd: value.root || '',
        conversations: [],
        currentId: null,
        messages: [],
        partial: '',
        streaming: false,
        expanded: false,
        error: '',
      }
    }

    function createQuickChatStore(project) {
      let state = initialState(project)
      const listeners = new Set()
      const notify = () => listeners.forEach((listener) => listener())
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(patch) {
          state = { ...state, ...patch }
          notify()
        },
        setProject(nextProject) {
          const next = nextProject || blankProject()
          if (state.projectKey === next.id) {
            state = { ...state, project: next, cwd: next.root || state.cwd }
          } else {
            state = {
              ...initialState(next),
              open: state.open,
              loading: state.open,
            }
          }
          notify()
        },
      }
    }

    function projectKeyOf(project) {
      return project?.id || ''
    }

    function requestContext(project) {
      const cwd = project?.cwd || project?.root || ''
      const projectRoot = project?.projectRoot || project?.root || ''
      return { cwd, ...(projectRoot ? { projectRoot } : {}) }
    }

    function contextQuery(project) {
      const context = requestContext(project)
      const values = [`cwd=${encodeURIComponent(context.cwd)}`]
      if (context.projectRoot) values.push(`projectRoot=${encodeURIComponent(context.projectRoot)}`)
      return values.join('&')
    }

    function pathFor(id, suffix = '') {
      return `${ROUTE}/conversations/${encodeURIComponent(id)}${suffix}`
    }

    function decodeStreamLine(line, onEvent) {
      if (!line || !line.trim()) return null
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return null
      }
      if (event?.type === 'reasoning' || event?.type === 'reasoning-delta') return null
      onEvent?.(event)
      return event
    }

    function waitForNextPaint() {
      if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve()
          }
          const timeout = setTimeout(finish, 250)
          requestAnimationFrame(() => requestAnimationFrame(finish))
        })
      }
      return new Promise((resolve) => setTimeout(resolve, 0))
    }

    function isComposingEvent(event, recentlyComposing = () => false) {
      const nativeEvent = event?.nativeEvent
      return Boolean(
        event?.isComposing
        || nativeEvent?.isComposing
        || event?.keyCode === 229
        || event?.which === 229
        || recentlyComposing()
      )
    }

    function shouldSubmitOnEnter(event, recentlyComposing = () => false) {
      return event?.key === 'Enter' && !event?.shiftKey && !isComposingEvent(event, recentlyComposing)
    }

    function createApiClient(fetchImpl = (...args) => fetch(...args)) {
      function urlFor(path) {
        if (typeof document === 'undefined') return path
        return new URL(path.replace(/^\/+/, '/'), document.baseURI).toString()
      }

      async function request(path, options = {}) {
        const response = await fetchImpl(urlFor(path), {
          cache: 'no-store',
          ...options,
          headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        return payload
      }

      return {
        list(project) {
          return request(`${ROUTE}/conversations?${contextQuery(project)}`)
        },
        create(project, title = '') {
          return request(`${ROUTE}/conversations`, { method: 'POST', body: JSON.stringify({ ...requestContext(project), title }) })
        },
        messages(project, id) {
          return request(`${pathFor(id, '/messages')}?${contextQuery(project)}`)
        },
        rename(project, id, title) {
          return request(pathFor(id), { method: 'PATCH', body: JSON.stringify({ ...requestContext(project), title }) })
        },
        remove(project, id) {
          return request(pathFor(id), { method: 'DELETE', body: JSON.stringify(requestContext(project)) })
        },
        cancel(project, id) {
          return request(pathFor(id, '/cancel'), { method: 'POST', body: JSON.stringify(requestContext(project)) })
        },
        async stream(project, id, text, { signal, onEvent } = {}) {
          const response = await fetchImpl(urlFor(pathFor(id, '/messages')), {
            method: 'POST',
            cache: 'no-store',
            signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestContext(project), text }),
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          if (!response.body?.getReader) throw new Error('stream body unavailable')
          const reader = response.body.getReader()
          const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null
          let buffer = ''
          let finalMessage = null
          let streamError = null
          const accept = (event) => {
            if (event?.type === 'done') finalMessage = event.message || null
            if (event?.type === 'error') streamError = event
          }
          const deliver = async (line) => {
            const event = decodeStreamLine(line, onEvent)
            accept(event)
            if (event?.type === 'delta' && event.text) await waitForNextPaint()
          }
          for (;;) {
            const step = await reader.read()
            if (step.done) break
            if (decoder) buffer += decoder.decode(step.value, { stream: true })
            else buffer += String.fromCharCode(...step.value)
            let newline = buffer.indexOf('\n')
            while (newline !== -1) {
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf('\n')
              await deliver(line)
            }
          }
          if (decoder) buffer += decoder.decode()
          await deliver(buffer)
          if (streamError && !finalMessage) throw new Error(streamError.message || streamError.code || 'stream failed')
          return { message: finalMessage, error: streamError }
        },
      }
    }

    function formatDate(ts, locale = 'zh') {
      if (!Number.isFinite(ts)) return ''
      const delta = Date.now() - ts
      if (delta < 60 * 1000) return locale === 'zh' ? '刚刚' : 'now'
      if (delta < 60 * 60 * 1000) return locale === 'zh' ? `${Math.floor(delta / 60000)}分钟前` : `${Math.floor(delta / 60000)}m`
      if (delta < 24 * 60 * 60 * 1000) return locale === 'zh' ? `${Math.floor(delta / 3600000)}小时前` : `${Math.floor(delta / 3600000)}h`
      const date = new Date(ts)
      return locale === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日` : date.toLocaleDateString()
    }

    function iconButton({ label, onClick, children, disabled = false, size = 32, style = {}, onMouseEnter, onMouseLeave, onFocus, onBlur }) {
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        disabled,
        onClick,
        onMouseEnter,
        onMouseLeave,
        onFocus,
        onBlur,
        style: {
          width: size,
          height: size,
          flex: 'none',
          border: 'none',
          borderRadius: size / 2,
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          color: colors.secondary,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.42 : 1,
          font: 'inherit',
          lineHeight: 1,
          ...style,
        },
      }, children)
    }

    function HeaderAction({ label, onClick, children, disabled = false, style = {} }) {
      const [hovered, setHovered] = useState(false)
      const enter = () => setHovered(true)
      const leave = () => setHovered(false)
      return iconButton({
        label,
        onClick,
        children,
        disabled,
        size: 30,
        onMouseEnter: enter,
        onMouseLeave: leave,
        onFocus: enter,
        onBlur: leave,
        style: headerActionStyle(hovered, style),
      })
    }

    let pluginCtx = null
    let panelStore = createQuickChatStore()
    let quickChatSettingsScope = null
    let api = null
    let loadSerial = 0
    const aborters = new Map()

    function currentSessionContext(preferredId) {
      const list = pluginCtx?.sessions?.list
      const workspaces = pluginCtx?.workspaces?.list
      let snapshot
      let workspaceSnapshot
      try { snapshot = list?.getSnapshot?.() } catch { snapshot = undefined }
      try { workspaceSnapshot = workspaces?.getSnapshot?.() } catch { workspaceSnapshot = undefined }
      return projectContextForSession(snapshot, workspaceSnapshot, preferredId)
    }

    function projectContextForSession(sessionsSnapshot, workspacesSnapshot, preferredId) {
      const sessionId = preferredId || sessionsSnapshot?.current
      const row = sessionId ? sessionsSnapshot?.byId?.[sessionId] : undefined
      const workspace = sessionId
        ? (workspacesSnapshot?.items || []).find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        : undefined
      return {
        sessionId,
        cwd: row?.cwd || workspace?.path || '',
        projectRoot: workspace?.path || '',
      }
    }

    function stateProject() {
      const snapshot = panelStore.getSnapshot()
      const projectRoot = snapshot.project.root || snapshot.cwd
      return { root: projectRoot, projectRoot, cwd: snapshot.cwd || projectRoot }
    }

    async function loadProject(context) {
      const serial = ++loadSerial
      if (!context?.cwd) {
        panelStore.set({ loaded: true, loading: false, error: 'projectUnavailable', project: blankProject(), projectKey: '', conversations: [], currentId: null, messages: [] })
        return
      }
      panelStore.set({ loading: true, error: '' })
      try {
        const data = await api.list({ root: context.projectRoot || context.cwd, cwd: context.cwd, projectRoot: context.projectRoot })
        if (serial !== loadSerial) return
        const project = data.project || blankProject()
        panelStore.setProject(project)
        panelStore.set({ cwd: context.cwd, project, conversations: data.conversations || [], loaded: true, loading: false, error: '' })
      } catch (error) {
        if (serial !== loadSerial) return
        panelStore.set({ loaded: true, loading: false, error: error.message || 'requestFailed' })
      }
    }

    function openPanel(sessionId) {
      const context = currentSessionContext(sessionId)
      panelStore.set({ open: true, loading: true, error: '', currentId: null, messages: [], partial: '', streaming: false })
      loadProject(context)
    }

    function collapsePanel() {
      panelStore.set({ open: false, streaming: false })
    }

    async function createConversation() {
      const snapshot = panelStore.getSnapshot()
      const project = stateProject()
      if (!project.root) {
        panelStore.set({ error: 'projectUnavailable' })
        return null
      }
      try {
        const data = await api.create(project)
        const conversation = data.conversation
        panelStore.set({
          project: data.project || snapshot.project,
          projectKey: data.project?.id || snapshot.projectKey,
          conversations: [conversation, ...snapshot.conversations.filter((item) => item.id !== conversation.id)],
          currentId: conversation.id,
          messages: [],
          partial: '',
          error: '',
        })
        return conversation
      } catch (error) {
        panelStore.set({ error: error.message || 'requestFailed' })
        return null
      }
    }

    async function selectConversation(id) {
      const project = stateProject()
      panelStore.set({ currentId: id, messages: [], partial: '', error: '' })
      try {
        const data = await api.messages(project, id)
        panelStore.set({ messages: visibleMessages(data.messages), error: '' })
      } catch (error) {
        panelStore.set({ error: error.message || 'requestFailed' })
      }
    }

    async function renameConversation(id, title, t) {
      const nextTitle = typeof title === 'string' ? title.trim() : ''
      if (!nextTitle) return
      try {
        const data = await api.rename(stateProject(), id, nextTitle)
        const snapshot = panelStore.getSnapshot()
        panelStore.set({ conversations: snapshot.conversations.map((item) => item.id === id ? data.conversation : item), error: '' })
      } catch (error) {
        panelStore.set({ error: error.message || t('requestFailed') })
      }
    }

    async function removeConversation(id, t) {
      if (typeof window !== 'undefined' && !window.confirm(t('removeConfirm'))) return
      try {
        await api.remove(stateProject(), id)
        const snapshot = panelStore.getSnapshot()
        const conversations = snapshot.conversations.filter((item) => item.id !== id)
        panelStore.set({ conversations, currentId: snapshot.currentId === id ? null : snapshot.currentId, messages: snapshot.currentId === id ? [] : snapshot.messages, error: '' })
      } catch (error) {
        panelStore.set({ error: error.message || t('requestFailed') })
      }
    }

    async function sendMessage(text) {
      const value = String(text || '').trim()
      if (!value || value.length > MAX_DRAFT) return
      let snapshot = panelStore.getSnapshot()
      let id = snapshot.currentId
      if (snapshot.streaming) return
      if (!id) {
        const conversation = await createConversation()
        if (!conversation) return
        id = conversation.id
        snapshot = panelStore.getSnapshot()
      }
      const userMessage = { role: 'user', text: value, ts: Date.now(), status: 'ok' }
      panelStore.set({ messages: snapshot.messages.concat([userMessage]), partial: '', streaming: true, error: '' })
      const controller = new AbortController()
      aborters.set(id, controller)
      let doneReceived = false
      try {
        const result = await api.stream(stateProject(), id, value, {
          signal: controller.signal,
          onEvent(event) {
            const current = panelStore.getSnapshot()
            if (event.type === 'meta' && event.conversation) {
              panelStore.set({ conversations: current.conversations.map((item) => item.id === id ? { ...item, ...event.conversation } : item) })
            } else if (event.type === 'title' && event.title) {
              panelStore.set({ conversations: current.conversations.map((item) => item.id === id ? { ...item, title: event.title } : item) })
            } else if (event.type === 'delta') {
              panelStore.set({ partial: current.partial + (event.text || '') })
            } else if (event.type === 'done' && event.message) {
              const { reasoning: _reasoning, ...message } = event.message
              doneReceived = true
              panelStore.set({ messages: current.messages.concat([message]), partial: '', streaming: false, error: '' })
            }
          },
        })
        const after = panelStore.getSnapshot()
        if (!doneReceived) {
          const assistant = result.message || {
            role: 'assistant',
            text: after.partial,
            ts: Date.now(),
            status: result.error ? 'error' : 'ok',
          }
          const { reasoning: _reasoning, ...visibleAssistant } = assistant
          panelStore.set({ messages: after.messages.concat([visibleAssistant]), partial: '', streaming: false, error: result.error?.message || '' })
        } else if (result.error) {
          panelStore.set({ error: result.error.message || result.error.code || '' })
        }
      } catch (error) {
        const after = panelStore.getSnapshot()
        const aborted = error?.name === 'AbortError' || controller.signal.aborted
        const ownsRequest = aborters.get(id) === controller
        if (!ownsRequest && !doneReceived) return
        const partial = after.partial
        panelStore.set({
          messages: partial ? after.messages.concat([{ role: 'assistant', text: partial, ts: Date.now(), status: aborted ? 'aborted' : 'error' }]) : after.messages,
          partial: '',
          streaming: false,
          error: aborted ? '' : (error.message || 'requestFailed'),
        })
      } finally {
        if (aborters.get(id) === controller) aborters.delete(id)
      }
    }

    function stopMessage() {
      const snapshot = panelStore.getSnapshot()
      const id = snapshot.currentId
      const controller = id ? aborters.get(id) : undefined
      controller?.abort()
      if (id) api.cancel(stateProject(), id).catch(() => {})
    }

    function Trigger(props) {
      const snapshot = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot, panelStore.getSnapshot)
      const t = props.t || ((key) => key)
      const open = snapshot.open
      return iconButton({
        label: open ? t('collapse') : t('open'),
        onClick: () => open ? collapsePanel() : openPanel(props.sessionId),
        size: 32,
        style: { color: open ? '#fff' : colors.secondary, background: open ? colors.accent : 'transparent', fontSize: 15, fontWeight: 600 },
        children: '?',
      })
    }

    function Header({ t, snapshot }) {
      const current = snapshot.currentId
        ? snapshot.conversations.find((item) => item.id === snapshot.currentId)
        : undefined
      const title = current?.title || t('newChat')
      return h('div', { style: { flex: 'none', padding: '18px 18px 12px', display: 'flex', alignItems: 'flex-start', gap: 10 } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h('div', { title, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 22, lineHeight: 1.2, fontWeight: 500, letterSpacing: '-0.3px', color: colors.text } }, title)
          ),
          snapshot.project?.title ? h('div', { title: snapshot.project.root, style: { marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: colors.tertiary } }, `${t('project')} · ${snapshot.project.title}`) : null
        ),
        h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none', padding: 3, border: `1px solid ${colors.border}`, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.46))', backdropFilter: 'blur(18px) saturate(1.35)', WebkitBackdropFilter: 'blur(18px) saturate(1.35)', boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)' } },
          h(HeaderAction, { label: t('new'), onClick: () => { createConversation() }, style: { fontSize: 22, fontWeight: 300 }, children: '+' }),
          h(HeaderAction, { label: t('collapse'), onClick: collapsePanel, style: { fontSize: 20, fontWeight: 300 }, children: '−' })
        )
      )
    }

    function ConversationRow({ item, t, onSelect, onRename, onRemove }) {
      const [hover, setHover] = useState(false)
      return h('div', {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => onSelect(item.id),
        style: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 38, padding: '0 2px 0 0', borderRadius: 10, cursor: 'pointer', background: hover ? colors.hover : 'transparent' },
      },
        h('div', { style: { flex: 1, minWidth: 0, padding: '7px 8px 7px 10px' } },
          h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: colors.text } }, item.title || 'Untitled'),
          h('div', { style: { marginTop: 2, fontSize: 11.5, color: colors.tertiary } }, formatDate(item.updatedAt))
        ),
        hover ? h('div', { style: { display: 'flex', gap: 0, paddingRight: 3 } },
          iconButton({ label: t('rename'), onClick: (event) => { event.stopPropagation(); const next = typeof window !== 'undefined' ? window.prompt(t('renamePrompt'), item.title || '') : ''; if (next) onRename(item.id, next) }, size: 26, children: '✎', style: { fontSize: 13 } }),
          iconButton({ label: t('remove'), onClick: (event) => { event.stopPropagation(); onRemove(item.id) }, size: 26, children: '×', style: { fontSize: 17 } })
        ) : null
      )
    }

    function RecentChats({ snapshot, t, onSelect, onRename, onRemove }) {
      const visible = snapshot.expanded ? snapshot.conversations : snapshot.conversations.slice(0, 3)
      return h('section', { style: { flex: 'none', padding: '6px 14px 8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '0 6px 5px' } },
          h('div', { style: { flex: 1, fontSize: 15, color: colors.secondary, letterSpacing: '-0.1px' } }, t('recent'))
        ),
        snapshot.loading ? h('div', { style: { padding: '10px 6px', fontSize: 13, color: colors.tertiary } }, t('loading')) : null,
        !snapshot.loading && visible.length === 0 ? h('div', { style: { padding: '6px', fontSize: 13, color: colors.tertiary } }, t('empty')) : null,
        visible.map((item) => h(ConversationRow, { key: item.id, item, t, onSelect, onRename, onRemove })),
        snapshot.conversations.length > 3 ? h('button', { type: 'button', onClick: () => panelStore.set({ expanded: !snapshot.expanded }), style: { border: 'none', background: 'transparent', color: colors.secondary, cursor: 'pointer', padding: '5px 6px', font: 'inherit', fontSize: 13 } }, snapshot.expanded ? t('seeLess') : t('seeAll')) : null
      )
    }

    function MessageBubble({ message }) {
      const user = message.role === 'user'
      const text = message.text || ''
      return h('div', { style: { display: 'flex', justifyContent: user ? 'flex-end' : 'flex-start', padding: '3px 0' } },
        h('div', { style: { maxWidth: '88%', padding: '9px 11px', borderRadius: user ? '16px 16px 4px 16px' : '12px', background: user ? colors.accentSoft : 'transparent', border: 'none', color: colors.text, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          text || (message.status === 'aborted' ? '…' : ''),
          message.status === 'error' ? h('div', { style: { marginTop: 5, color: colors.tertiary, fontSize: 11.5 } }, '⚠') : null
        )
      )
    }

    function Thread({ snapshot, t }) {
      const endRef = useRef(null)
      useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [snapshot.messages.length, snapshot.partial])
      const messages = snapshot.streaming && snapshot.partial
        ? snapshot.messages.concat([{ role: 'assistant', text: snapshot.partial, status: 'ok' }])
        : snapshot.messages
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        snapshot.currentId ? h('button', { type: 'button', onClick: () => panelStore.set({ currentId: null, messages: [], partial: '', error: '' }), style: { flex: 'none', alignSelf: 'flex-start', border: 'none', background: 'transparent', color: colors.secondary, cursor: 'pointer', padding: '5px 18px 9px', font: 'inherit', fontSize: 12.5 } }, `‹ ${t('back')}`) : null,
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 18px 8px' } },
          messages.length === 0 && snapshot.currentId ? h('div', { style: { padding: '28px 5px', color: colors.tertiary, fontSize: 13, textAlign: 'center' } }, t('emptyThread')) : null,
          messages.map((message, index) => h(MessageBubble, { key: `${message.ts || index}-${index}`, message })),
          snapshot.streaming && !snapshot.partial ? h('div', { style: { color: colors.accent, fontSize: 17, padding: '5px 0', animation: 'dsh-quickchat-pulse 1.1s ease-in-out infinite alternate' } }, '●') : null,
          snapshot.error ? h('div', { style: { color: colors.tertiary, fontSize: 12, padding: '5px 0', whiteSpace: 'pre-wrap' } }, `⚠ ${snapshot.error}`) : null,
          h('div', { ref: endRef })
        )
      )
    }

    function Composer({ snapshot, t }) {
      const [draft, setDraft] = useState('')
      const inputRef = useRef(null)
      const composingRef = useRef(false)
      const composingUntilRef = useRef(0)
      const recentlyComposing = () => composingRef.current || Date.now() < composingUntilRef.current
      const submit = () => {
        const value = draft.trim()
        if (!value || snapshot.streaming) return
        setDraft('')
        sendMessage(value)
      }
      useEffect(() => {
        if (snapshot.open && inputRef.current) inputRef.current.focus()
      }, [snapshot.open, snapshot.currentId])
      return h('div', { style: { flex: 'none', padding: '10px 13px 13px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, padding: '7px 7px 7px 15px', border: `1px solid ${colors.border}`, borderRadius: 27, background: colors.panel, boxShadow: '0 3px 15px rgba(0, 0, 0, 0.035)' } },
          h('textarea', { ref: inputRef, value: draft, maxLength: MAX_DRAFT, rows: 1, placeholder: t('placeholder'), onChange: (event) => setDraft(event.target.value), onCompositionStart: () => { composingRef.current = true }, onCompositionEnd: () => { composingRef.current = false; composingUntilRef.current = Date.now() + 10 }, onKeyDown: (event) => { if (shouldSubmitOnEnter(event, recentlyComposing)) { event.preventDefault(); submit() } }, style: { flex: 1, minWidth: 0, maxHeight: 110, alignSelf: 'center', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: colors.text, padding: '7px 0 6px', font: 'inherit', fontSize: 14, lineHeight: 1.35 } }),
          iconButton({ label: snapshot.streaming ? t('stop') : t('send'), onClick: snapshot.streaming ? stopMessage : submit, size: 36, children: snapshot.streaming ? '■' : '↑', style: { background: snapshot.streaming ? colors.hover : colors.accent, color: snapshot.streaming ? colors.secondary : '#fff', fontSize: snapshot.streaming ? 12 : 20 } })
        )
      )
    }

    function remoteListValue(result) {
      if (Array.isArray(result)) return result
      return result?.ok && Array.isArray(result.value) ? result.value : []
    }

    function visibleMessages(messages) {
      if (!Array.isArray(messages)) return []
      return messages.filter((item) => item && typeof item === 'object').map((item) => {
        const { reasoning: _reasoning, ...visible } = item
        return visible
      })
    }

    function remoteObjectValue(result) {
      if (result?.ok === false) return null
      if (result?.ok && result.value && typeof result.value === 'object') return result.value
      return result && typeof result === 'object' ? result : null
    }

    function normalizeModelEntry(item) {
      const id = typeof item === 'string' ? item : item?.id
      if (!id) return null
      return { id: String(id), name: typeof item === 'string' ? String(item) : (item.name || String(id)) }
    }

    function normalizeProviderEntry(item) {
      const id = typeof item === 'string' ? item : item?.id
      if (!id) return null
      return { id: String(id), name: typeof item === 'string' ? String(item) : (item.name || String(id)) }
    }

    function modelCatalogProjection(catalog) {
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const entries = groups.map((group) => {
        const provider = normalizeProviderEntry(group)
        if (!provider) return null
        return {
          provider,
          models: (Array.isArray(group.models) ? group.models : []).map(normalizeModelEntry).filter(Boolean),
        }
      }).filter(Boolean)
      return {
        providers: entries.map((item) => item.provider),
        modelsByProvider: Object.fromEntries(entries.map((item) => [item.provider.id, item.models])),
      }
    }

    function QuickChatSettingsCard({ scope, llm, session, t }) {
      const settings = scope?.subscribe && scope?.getSnapshot
        ? useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot(), () => scope.getSnapshot())
        : scope?.getSnapshot?.()
      const value = settings?.value || { provider: '', model: '' }
      const [providers, setProviders] = useState([])
      const [modelsByProvider, setModelsByProvider] = useState({})
      const [catalogStatus, setCatalogStatus] = useState('idle')

      const write = (field, next) => {
        try { return Promise.resolve(scope.set(field, next)).catch(() => {}) } catch { return Promise.resolve() }
      }

      useEffect(() => {
        let alive = true
        setCatalogStatus('loading')
        if (session?.modelCatalog) {
          Promise.resolve(session.modelCatalog()).then((result) => {
            if (!alive) return
            const catalog = remoteObjectValue(result)
            if (!catalog) throw new Error('model catalog unavailable')
            const projection = modelCatalogProjection(catalog)
            setProviders(projection.providers)
            setModelsByProvider(projection.modelsByProvider)
            setCatalogStatus('ready')
          }).catch(() => {
            if (!alive) return
            setProviders([])
            setModelsByProvider({})
            setCatalogStatus('error')
          })
          return () => { alive = false }
        }
        if (!llm?.listProviders) {
          setProviders([])
          setModelsByProvider({})
          setCatalogStatus('error')
          return () => { alive = false }
        }
        Promise.resolve(llm.listProviders()).then(async (result) => {
          const nextProviders = remoteListValue(result).map(normalizeProviderEntry).filter(Boolean)
          const entries = await Promise.all(nextProviders.map(async (provider) => {
            if (!llm.listModels) return [provider.id, []]
            try {
              const models = await llm.listModels(provider.id)
              return [provider.id, remoteListValue(models).map(normalizeModelEntry).filter(Boolean)]
            } catch {
              return [provider.id, []]
            }
          }))
          return { nextProviders, nextModels: Object.fromEntries(entries) }
        }).then((result) => {
          if (!alive) return
          setProviders(result.nextProviders)
          setModelsByProvider(result.nextModels)
          setCatalogStatus('ready')
        }).catch(() => {
          if (!alive) return
          setProviders([])
          setModelsByProvider({})
          setCatalogStatus('error')
        })
        return () => { alive = false }
      }, [session, llm])

      useEffect(() => {
        const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
        const available = provider ? (modelsByProvider[provider] || []) : []
        if ((!provider && value.model) || (catalogStatus === 'ready' && value.model && !available.some((item) => item.id === value.model))) write('model', '')
      }, [value.provider, value.model, catalogStatus, modelsByProvider, settings?.revision])

      if (!settings || settings.status === 'unavailable') {
        return h('section', { style: { padding: 18, border: `1px solid ${colors.border}`, borderRadius: 18, color: colors.tertiary } }, t('settingsUnavailable'))
      }

      const providerOptions = providers.map(normalizeProviderEntry).filter(Boolean)
      if (value.provider && !providerOptions.some((item) => item.id === value.provider)) providerOptions.unshift({ id: value.provider, name: value.provider })
      const provider = value.provider || ''
      const catalogModels = provider ? (modelsByProvider[provider] || []) : []
      const modelOptions = catalogModels.slice()
      if (value.model && !modelOptions.some((item) => item.id === value.model)) modelOptions.unshift({ id: value.model, name: value.model })
      const modelValue = provider && value.model ? value.model : ''
      const changeProvider = (event) => {
        const next = event.target.value
        write('provider', next)
        if (value.model) write('model', '')
      }

      const fieldStyle = { display: 'flex', alignItems: 'center', gap: 12, minHeight: 38 }
      const labelStyle = { width: 132, flex: 'none', fontSize: 13, color: colors.secondary }
      const controlStyle = { flex: 1, minWidth: 0, height: 34, padding: '0 10px', border: `1px solid ${colors.border}`, borderRadius: 9, background: colors.panel, color: colors.text, font: 'inherit', fontSize: 13, outline: 'none' }
      return h('section', { style: { margin: '8px 0', padding: 18, border: `1px solid ${colors.border}`, borderRadius: 18, background: colors.panel, color: colors.text } },
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, t('settingsTitle')),
        h('div', { style: { marginTop: 5, marginBottom: 14, color: colors.tertiary, fontSize: 12.5, lineHeight: 1.45 } }, t('settingsDescription')),
        h('label', { style: fieldStyle },
          h('span', { style: labelStyle }, t('settingsProvider')),
          h('select', { value: provider, onChange: changeProvider, style: controlStyle },
            h('option', { value: '' }, t('settingsDefaultProvider')),
            providerOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id))
          )
        ),
        h('label', { style: fieldStyle },
          h('span', { style: labelStyle }, t('settingsModel')),
          h('select', { value: modelValue, disabled: !provider || catalogStatus === 'loading' || catalogStatus === 'error' || (catalogStatus === 'ready' && catalogModels.length === 0), onChange: (event) => { const next = event.target.value; write('model', next); if (!next) write('provider', '') }, style: controlStyle },
            h('option', { value: '' }, !provider
              ? t('settingsDefaultModel')
              : catalogStatus === 'loading'
                ? t('settingsModelsLoading')
                : catalogStatus === 'error' || catalogModels.length === 0
                  ? t('settingsModelsUnavailable')
                  : t('settingsDefaultModel')),
            modelOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id))
          )
        )
      )
    }

    function QuickChatPanel({ t }) {
      const snapshot = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot, panelStore.getSnapshot)
      const sessionState = currentSessionContext()
      const geometry = useQuickChatPanelGeometry()
      useEffect(() => {
        if (!snapshot.open) return undefined
        const cwd = sessionState.cwd
        const projectRoot = sessionState.projectRoot
        if (cwd && (cwd !== snapshot.cwd || (projectRoot && projectRoot !== snapshot.project.root))) {
          loadProject({ sessionId: sessionState.sessionId, cwd, projectRoot })
        }
        return undefined
      }, [snapshot.open, sessionState.cwd, sessionState.projectRoot, sessionState.sessionId])
      useEffect(() => {
        if (!snapshot.open || typeof window === 'undefined') return undefined
        const onKey = (event) => { if (event.key === 'Escape') collapsePanel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [snapshot.open])
      if (!snapshot.open) return null
      const dismissOutside = (event) => {
        if (event.target === event.currentTarget) collapsePanel()
      }
      const shellStyle = { position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'auto' }
      const panelStyle = {
        pointerEvents: 'auto',
        position: 'fixed',
        top: geometry.top,
        right: QUICKCHAT_PANEL_MARGIN,
        width: 'min(480px, calc(100vw - 24px))',
        height: geometry.height,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: `1px solid ${colors.border}`,
        borderRadius: 27,
        background: colors.panel,
        boxShadow: '0 20px 70px rgba(0, 0, 0, 0.18)',
        color: colors.text,
      }
      return h('div', { 'data-quickchat-mode': 'overlay', style: shellStyle, onMouseDown: dismissOutside },
        h('div', { 'data-quickchat-dialog': true, role: 'dialog', 'aria-label': t('quickChat'), style: panelStyle },
          h(Header, { t, snapshot }),
          snapshot.currentId ? h(Thread, { snapshot, t }) : h('div', { style: { flex: 1, minHeight: 0 } }),
          snapshot.currentId ? h(Composer, { snapshot, t }) : h(RecentChats, { snapshot, t, onSelect: selectConversation, onRename: (id, title) => renameConversation(id, title, t), onRemove: (id) => removeConversation(id, t) }),
          !snapshot.currentId ? h(Composer, { snapshot, t }) : null
        )
      )
    }

    function bindLocale(ctx) {
      if (ctx.locale?.bind) return ctx.locale.bind(NS)
      return (key) => dictionaries.zh[key] || key
    }

    function registerClient(ctx) {
      pluginCtx = ctx
      api = createApiClient()
      const t = bindLocale(ctx)
      if (ctx.locale?.register) ctx.effect?.(() => ctx.locale.register(NS, dictionaries), `dsh-quickchat: locale`)

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'quickchat-trigger',
        order: 95,
        locale: NS,
      }, (props) => h(Trigger, { ...props, t })))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'quickchat-panel',
        order: 90,
        locale: NS,
      }, () => h(QuickChatPanel, { t })))

      if (typeof ctx.inject === 'function') {
        ctx.inject(['settingsScope'], (scoped) => {
          const settingsScope = scoped.settingsScope?.bind?.({ namespace: SETTINGS_NAMESPACE })
          if (!settingsScope) return
          quickChatSettingsScope = settingsScope
          ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
            name: 'settings.plugin.item',
            key: SETTINGS_NAMESPACE,
            locale: NS,
            inject: () => ({ scope: settingsScope, llm: ctx.remote?.llm, session: ctx.remote?.session, t }),
          }, QuickChatSettingsCard))
        })
      }

      const list = ctx.sessions?.list
      if (list?.subscribe) {
        ctx.effect?.(() => list.subscribe(() => {
          const snapshot = panelStore.getSnapshot()
          if (!snapshot.open) return
          const current = currentSessionContext()
          if (current.cwd && (current.cwd !== snapshot.cwd || (current.projectRoot && current.projectRoot !== snapshot.project.root))) loadProject(current)
        }), `dsh-quickchat: current project`)
      }
    }

    const plugin = {
      name: 'quickchat',
      inject: ['slots', 'sessions', 'workspaces', 'locale', 'settingsScope', 'remote', 'remote.llm', 'remote.session'],
      apply: registerClient,
      __test: {
        createQuickChatStore,
        projectContextForSession,
        projectKeyOf,
        createApiClient,
        decodeStreamLine,
        visibleMessages,
        modelCatalogProjection,
        isComposingEvent,
        shouldSubmitOnEnter,
        formatDate,
        quickChatPanelGeometry,
        readConversationContentRect,
        headerActionStyle,
        setPanelState: (patch) => panelStore.set(patch),
        resetPanelState: () => { panelStore = createQuickChatStore() },
      },
    }
    return plugin
  },
})
