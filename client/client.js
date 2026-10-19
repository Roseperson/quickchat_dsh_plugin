/*
 * dsh-quickchat WebUI 客户端。
 * 保持 DSH 的 lazy-CJS 格式：启动时只登记工厂，插件激活后才加载 React。
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
    const ROUTE = '/quickchat/api'
    const MAX_DRAFT = 32000
    const dictionaries = {
      zh: {
        quickChat: '临时对话',
        newChat: 'New chat',
        recent: 'Recent chats',
        placeholder: 'Message…',
        send: '发送',
        stop: '停止',
        new: '新建对话',
        close: '关闭临时对话',
        guideDescription: '在当前项目中开始或继续临时对话',
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
        settingsUnavailable: '模型设置暂不可用',
        settingsReadOnly: '当前模型设置为只读',
        settingsWriteFailed: '设置未保存，请重试',
        settingsBack: '返回对话',
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
        close: 'Close quick chat',
        guideDescription: 'Start or resume a quick chat in this project',
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
        settingsUnavailable: 'Model settings are unavailable',
        settingsReadOnly: 'Model settings are read-only',
        settingsWriteFailed: 'Settings were not saved. Try again.',
        settingsBack: 'Back to chat',
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

    function headerActionStyle(hovered, style = {}) {
      return {
        ...style,
        background: hovered ? colors.hover : (style.background || 'transparent'),
        color: hovered ? colors.text : (style.color || colors.secondary),
        transition: 'background 140ms ease, color 140ms ease, transform 140ms ease',
        transform: hovered ? 'scale(1.04)' : 'scale(1)',
      }
    }

    function blankProject() {
      return { id: '', root: '', title: '' }
    }

    function initialState(project) {
      const value = project || blankProject()
      return {
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
        draft: '',
        settingsOpen: false,
        creating: false,
        loadingThread: false,
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
            state = initialState(next)
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

    function projectContextForSession(sessionsSnapshot, workspacesSnapshot, preferredId) {
      // keepMounted 的后台 body 必须继续使用自己的 session，不能跟随前台会话。
      const sessionId = preferredId || Object.values(sessionsSnapshot?.byId || {})
        .find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id
      const row = sessionId ? sessionsSnapshot?.byId?.[sessionId] : undefined
      const workspace = sessionId
        ? (workspacesSnapshot?.items || []).find((item) => item.sessionIds?.includes(sessionId))
        : undefined
      return { sessionId, cwd: row?.cwd || workspace?.path || '', projectRoot: workspace?.path || '' }
    }

    // 每个 body 自持 store、请求代次和取消句柄；工厂本身不订阅、不发请求。
    function createQuickChatTabController({ api = createApiClient() } = {}) {
      const store = createQuickChatStore()
      let context = null
      let generation = 0
      let loadSerial = 0
      let selectionSerial = 0
      let activeRequest = null
      let disposed = false
      const isCurrent = (version) => !disposed && version === generation
      const busy = () => {
        const state = store.getSnapshot()
        return state.streaming || state.creating || state.loadingThread || state.loading
      }
      const stateProject = () => {
        const state = store.getSnapshot()
        return { cwd: state.cwd, projectRoot: state.project.root || context?.projectRoot || state.cwd }
      }

      function cancelRequest() {
        const request = activeRequest
        if (!request || request.abort.signal.aborted) return
        request.abort.abort()
        // 只取消本 body 实际发出的请求，不能用当前所选 chat 去取消其他 body 的任务。
        if (request.started && !request.doneReceived) Promise.resolve().then(() => api.cancel(request.project, request.id)).catch(() => {})
      }

      async function loadProject(nextContext) {
        if (disposed) return
        const next = { sessionId: nextContext?.sessionId, cwd: nextContext?.cwd || '', projectRoot: nextContext?.projectRoot || '' }
        const changed = !context || Object.keys(next).some((key) => next[key] !== context[key])
        if (!changed && busy()) return
        if (changed) {
          cancelRequest()
          activeRequest = null
          generation += 1
          selectionSerial += 1
          context = next
          store.set(initialState())
        }
        const version = generation
        const serial = ++loadSerial
        if (!next.cwd) {
          store.set({ loaded: true, loading: false, error: 'projectUnavailable' })
          return
        }
        store.set({ loading: true, error: '' })
        try {
          const data = await api.list(next)
          if (!isCurrent(version) || serial !== loadSerial) return
          const project = data.project || blankProject()
          if (store.getSnapshot().projectKey !== project.id) store.setProject(project)
          store.set({ cwd: next.cwd, project, projectKey: project.id, conversations: data.conversations || [], loaded: true, loading: false, error: '' })
          const state = store.getSnapshot()
          if (state.currentId && !state.conversations.some((item) => item.id === state.currentId)) backToRecent()
        } catch (error) {
          if (isCurrent(version) && serial === loadSerial) store.set({ loaded: true, loading: false, error: error.message || 'requestFailed' })
        }
      }

      async function createRecord(version) {
        const data = await api.create(stateProject())
        if (!isCurrent(version)) return null
        const conversation = data.conversation
        if (!conversation?.id) throw new Error('requestFailed')
        const state = store.getSnapshot()
        store.set({
          project: data.project || state.project,
          projectKey: data.project?.id || state.projectKey,
          conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
          currentId: conversation.id, messages: [], partial: '', error: '', settingsOpen: false,
        })
        return conversation
      }

      async function createConversation() {
        if (disposed || busy()) return null
        if (!store.getSnapshot().cwd) { store.set({ error: 'projectUnavailable' }); return null }
        const version = generation
        store.set({ creating: true, error: '' })
        try {
          return await createRecord(version)
        } catch (error) {
          if (isCurrent(version)) store.set({ error: error.message || 'requestFailed' })
          return null
        } finally {
          if (isCurrent(version)) store.set({ creating: false })
        }
      }

      async function selectConversation(id) {
        if (disposed || store.getSnapshot().streaming || store.getSnapshot().creating || store.getSnapshot().loading) return
        const version = generation
        const serial = ++selectionSerial
        store.set({ currentId: id, messages: [], partial: '', loadingThread: true, error: '' })
        try {
          const data = await api.messages(stateProject(), id)
          if (isCurrent(version) && serial === selectionSerial) store.set({ messages: visibleMessages(data.messages), error: '' })
        } catch (error) {
          if (isCurrent(version) && serial === selectionSerial) store.set({ error: error.message || 'requestFailed' })
        } finally {
          if (isCurrent(version) && serial === selectionSerial) store.set({ loadingThread: false })
        }
      }

      function backToRecent() {
        if (disposed || busy()) return
        selectionSerial += 1
        store.set({ currentId: null, messages: [], partial: '', error: '' })
      }

      async function renameConversation(id, title) {
        const nextTitle = typeof title === 'string' ? title.trim() : ''
        if (disposed || !nextTitle || busy()) return
        const version = generation
        try {
          const data = await api.rename(stateProject(), id, nextTitle)
          if (!isCurrent(version)) return
          store.set({ conversations: store.getSnapshot().conversations.map((item) => item.id === id ? data.conversation : item), error: '' })
        } catch (error) {
          if (isCurrent(version)) store.set({ error: error.message || 'requestFailed' })
        }
      }

      async function removeConversation(id) {
        if (disposed || busy()) return
        const version = generation
        try {
          await api.remove(stateProject(), id)
          if (!isCurrent(version)) return
          const state = store.getSnapshot()
          if (state.currentId === id) selectionSerial += 1
          store.set({ conversations: state.conversations.filter((item) => item.id !== id), currentId: state.currentId === id ? null : state.currentId, messages: state.currentId === id ? [] : state.messages, error: '' })
        } catch (error) {
          if (isCurrent(version)) store.set({ error: error.message || 'requestFailed' })
        }
      }

      async function sendMessage(text) {
        const value = String(text || '').trim()
        if (disposed || !value || value.length > MAX_DRAFT || busy()) return false
        if (!store.getSnapshot().cwd) { store.set({ error: 'projectUnavailable' }); return false }
        const version = generation
        const request = { abort: new AbortController(), project: stateProject(), id: store.getSnapshot().currentId, started: false, doneReceived: false }
        activeRequest = request
        const ownsRequest = () => isCurrent(version) && activeRequest === request
        store.set({ streaming: true, draft: '', partial: '', error: '' })
        try {
          if (!request.id) request.id = (await createRecord(version))?.id
          if (!ownsRequest()) return false
          if (request.abort.signal.aborted) return false
          const state = store.getSnapshot()
          store.set({ messages: state.messages.concat([{ role: 'user', text: value, ts: Date.now(), status: 'ok' }]) })
          request.started = true
          const result = await api.stream(request.project, request.id, value, {
            signal: request.abort.signal,
            onEvent(event) {
              if (!ownsRequest() || request.abort.signal.aborted) return
              const current = store.getSnapshot()
              if (event.type === 'meta' && event.conversation) {
                store.set({ conversations: current.conversations.map((item) => item.id === request.id ? { ...item, ...event.conversation } : item) })
              } else if (event.type === 'title' && event.title) {
                store.set({ conversations: current.conversations.map((item) => item.id === request.id ? { ...item, title: event.title } : item) })
              } else if (event.type === 'delta' && !request.doneReceived) {
                store.set({ partial: current.partial + (event.text || '') })
              } else if (event.type === 'done' && event.message && !request.doneReceived) {
                request.doneReceived = true
                store.set({ messages: current.messages.concat(visibleMessages([event.message])), partial: '', error: '' })
              }
            },
          })
          if (!ownsRequest()) return false
          const after = store.getSnapshot()
          if (!request.doneReceived) {
            const assistant = request.abort.signal.aborted
              ? { role: 'assistant', text: after.partial, ts: Date.now(), status: 'aborted' }
              : result.message || { role: 'assistant', text: after.partial, ts: Date.now(), status: result.error ? 'error' : 'ok' }
            store.set({ messages: after.messages.concat(visibleMessages([assistant])), partial: '' })
          }
          if (result.error && !request.abort.signal.aborted) store.set({ error: result.error.message || result.error.code || 'requestFailed' })
          return true
        } catch (error) {
          if (!ownsRequest()) return false
          const after = store.getSnapshot()
          const aborted = error?.name === 'AbortError' || request.abort.signal.aborted
          store.set({
            messages: after.partial && !request.doneReceived ? after.messages.concat([{ role: 'assistant', text: after.partial, ts: Date.now(), status: aborted ? 'aborted' : 'error' }]) : after.messages,
            partial: '', error: aborted ? '' : (error.message || 'requestFailed'),
            draft: !request.started && !after.draft ? value : after.draft,
          })
          return false
        } finally {
          if (ownsRequest()) {
            activeRequest = null
            // done 之后可能还有 title 事件，直到本次响应结束才允许下一次发送。
            const state = store.getSnapshot()
            store.set({ streaming: false, draft: !request.started && request.abort.signal.aborted && !state.draft ? value : state.draft })
          }
        }
      }

      async function refresh() {
        if (disposed || !context || !store.getSnapshot().loaded || busy()) return
        const version = generation
        const selected = store.getSnapshot().currentId
        const selection = selectionSerial
        await loadProject(context)
        if (isCurrent(version) && selected && selected === store.getSnapshot().currentId && selection === selectionSerial) await selectConversation(selected)
      }

      function dispose() {
        cancelRequest()
        activeRequest = null
        disposed = true
        generation += 1
        loadSerial += 1
        selectionSerial += 1
        store.set({ streaming: false, loading: false, loadingThread: false, creating: false })
      }

      function mount(signal) {
        disposed = false
        if (signal?.aborted) dispose()
        else signal?.addEventListener('abort', dispose, { once: true })
        return () => { signal?.removeEventListener('abort', dispose); dispose() }
      }

      return { store, loadProject, refresh, createConversation, selectConversation, renameConversation, removeConversation, sendMessage, stopMessage: cancelRequest, backToRecent, mount, dispose }
    }

    function Header({ t, snapshot, controller, onClose }) {
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
          h(HeaderAction, { label: t('new'), disabled: snapshot.streaming || snapshot.creating || snapshot.loading || snapshot.loadingThread || !snapshot.cwd, onClick: controller.createConversation, style: { fontSize: 22, fontWeight: 300 }, children: '+' }),
          h(HeaderAction, { label: t('settingsTitle'), onClick: () => controller.store.set({ settingsOpen: !snapshot.settingsOpen }), style: { fontSize: 18 }, children: '⚙' }),
          h(HeaderAction, { label: t('close'), onClick: onClose, style: { fontSize: 20, fontWeight: 300 }, children: '×' })
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

    function RecentChats({ snapshot, t, onSelect, onRename, onRemove, onToggle }) {
      const visible = snapshot.expanded ? snapshot.conversations : snapshot.conversations.slice(0, 3)
      return h('section', { style: { flex: 'none', padding: '6px 14px 8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '0 6px 5px' } },
          h('div', { style: { flex: 1, fontSize: 15, color: colors.secondary, letterSpacing: '-0.1px' } }, t('recent'))
        ),
        snapshot.loading ? h('div', { style: { padding: '10px 6px', fontSize: 13, color: colors.tertiary } }, t('loading')) : null,
        !snapshot.loading && visible.length === 0 ? h('div', { style: { padding: '6px', fontSize: 13, color: colors.tertiary } }, t('empty')) : null,
        visible.map((item) => h(ConversationRow, { key: item.id, item, t, onSelect, onRename, onRemove })),
        snapshot.conversations.length > 3 ? h('button', { type: 'button', onClick: onToggle, style: { border: 'none', background: 'transparent', color: colors.secondary, cursor: 'pointer', padding: '5px 6px', font: 'inherit', fontSize: 13 } }, snapshot.expanded ? t('seeLess') : t('seeAll')) : null
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

    function Thread({ snapshot, t, onBack, visible }) {
      const endRef = useRef(null)
      useEffect(() => { if (visible) endRef.current?.scrollIntoView?.({ block: 'end' }) }, [snapshot.messages.length, snapshot.partial, visible])
      const messages = snapshot.streaming && snapshot.partial
        ? snapshot.messages.concat([{ role: 'assistant', text: snapshot.partial, status: 'ok' }])
        : snapshot.messages
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        snapshot.currentId ? h('button', { type: 'button', onClick: onBack, disabled: snapshot.streaming || snapshot.loadingThread, style: { flex: 'none', alignSelf: 'flex-start', border: 'none', background: 'transparent', color: colors.secondary, cursor: 'pointer', padding: '5px 18px 9px', font: 'inherit', fontSize: 12.5 } }, `‹ ${t('back')}`) : null,
        h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 18px 8px' } },
          messages.length === 0 && snapshot.currentId ? h('div', { style: { padding: '28px 5px', color: colors.tertiary, fontSize: 13, textAlign: 'center' } }, t('emptyThread')) : null,
          messages.map((message, index) => h(MessageBubble, { key: `${message.ts || index}-${index}`, message })),
          snapshot.streaming && !snapshot.partial ? h('div', { style: { color: colors.accent, fontSize: 17, padding: '5px 0', animation: 'dsh-quickchat-pulse 1.1s ease-in-out infinite alternate' } }, '●') : null,
          snapshot.loadingThread ? h('div', { style: { color: colors.tertiary, fontSize: 12 } }, t('loading')) : null,
          h('div', { ref: endRef })
        )
      )
    }

    function Composer({ snapshot, t, controller, visible }) {
      const draft = snapshot.draft
      const setDraft = (value) => controller.store.set({ draft: value })
      const disabled = snapshot.creating || snapshot.loading || snapshot.loadingThread || !snapshot.cwd
      const inputRef = useRef(null)
      const composingRef = useRef(false)
      const composingUntilRef = useRef(0)
      const recentlyComposing = () => composingRef.current || Date.now() < composingUntilRef.current
      const submit = () => {
        const value = draft.trim()
        if (!value || snapshot.streaming || disabled) return
        controller.sendMessage(value)
      }
      useEffect(() => {
        if (visible) inputRef.current?.focus()
      }, [visible, snapshot.currentId])
      return h('div', { style: { flex: 'none', padding: '10px 13px 13px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, padding: '7px 7px 7px 15px', border: `1px solid ${colors.border}`, borderRadius: 27, background: colors.panel, boxShadow: '0 3px 15px rgba(0, 0, 0, 0.035)' } },
          h('textarea', { ref: inputRef, value: draft, maxLength: MAX_DRAFT, rows: 1, placeholder: t('placeholder'), onChange: (event) => setDraft(event.target.value), onCompositionStart: () => { composingRef.current = true }, onCompositionEnd: () => { composingRef.current = false; composingUntilRef.current = Date.now() + 10 }, onKeyDown: (event) => { if (shouldSubmitOnEnter(event, recentlyComposing)) { event.preventDefault(); submit() } }, style: { flex: 1, minWidth: 0, maxHeight: 110, alignSelf: 'center', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: colors.text, padding: '7px 0 6px', font: 'inherit', fontSize: 14, lineHeight: 1.35 } }),
          iconButton({ label: snapshot.streaming ? t('stop') : t('send'), onClick: snapshot.streaming ? controller.stopMessage : submit, disabled: !snapshot.streaming && (disabled || !draft.trim()), size: 36, children: snapshot.streaming ? '■' : '↑', style: { background: snapshot.streaming ? colors.hover : colors.accent, color: snapshot.streaming ? colors.secondary : '#fff', fontSize: snapshot.streaming ? 12 : 20 } })
        )
      )
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

    const EMPTY_SETTINGS_SNAPSHOT = Object.freeze({ status: 'unavailable', value: Object.freeze({ provider: '', model: '' }), revision: undefined, writable: false })
    const noopSubscribe = () => () => {}

    function settingsSnapshot(form) {
      try { return form?.getSnapshot?.() || EMPTY_SETTINGS_SNAPSHOT } catch { return EMPTY_SETTINGS_SNAPSHOT }
    }

    function settingsNotice(settings) {
      if (settings?.status === 'loading') return 'loading'
      if (settings?.status !== 'ready') return 'settingsUnavailable'
      return settings.writable === true ? '' : 'settingsReadOnly'
    }

    async function writeSetting(form, field, value) {
      if (settingsNotice(settingsSnapshot(form)) || typeof form?.set !== 'function') return false
      try { return await form.set(field, value) === true } catch { return false }
    }

    async function updateQuickChatSetting(form, field, value) {
      if (!['provider', 'model'].includes(field) || typeof value !== 'string') return false
      // 串行写入并检查每次接受结果；revision 和冲突恢复由官方表单控制器负责。
      if (field === 'provider' && settingsSnapshot(form).value?.provider !== value && settingsSnapshot(form).value?.model) {
        if (!await writeSetting(form, 'model', '')) return false
      }
      return writeSetting(form, field, value)
    }

    async function loadModelCatalog(session) {
      const catalog = remoteObjectValue(await session.modelCatalog())
      if (!Array.isArray(catalog?.groups)) throw new Error('model catalog unavailable')
      return modelCatalogProjection(catalog)
    }

    function QuickChatSettingsView({ form, session, t, onBack }) {
      const source = useMemo(() => ({
        subscribe: form?.subscribe ? (listener) => form.subscribe(listener) : noopSubscribe,
        getSnapshot: () => settingsSnapshot(form),
      }), [form])
      const settings = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      const value = settings.value || {}
      const [catalog, setCatalog] = useState({ providers: [], modelsByProvider: {}, status: 'loading' })
      const [saving, setSaving] = useState(false)
      const [writeError, setWriteError] = useState('')
      const writing = useRef(false)
      useEffect(() => {
        let alive = true
        loadModelCatalog(session).then((projection) => {
          if (alive) setCatalog({ ...projection, status: 'ready' })
        }).catch(() => {
          if (alive) setCatalog({ providers: [], modelsByProvider: {}, status: 'error' })
        })
        return () => { alive = false }
      }, [session])

      const write = async (field, next) => {
        if (writing.current) return
        writing.current = true
        setSaving(true)
        setWriteError('')
        const accepted = await updateQuickChatSetting(form, field, next)
        setWriteError(accepted ? '' : 'settingsWriteFailed')
        writing.current = false
        setSaving(false)
      }
      const notice = settingsNotice(settings)
      const disabled = Boolean(notice) || saving || typeof form?.set !== 'function'
      const provider = typeof value.provider === 'string' ? value.provider : ''
      const model = typeof value.model === 'string' ? value.model : ''
      const providers = catalog.providers.slice()
      const models = (catalog.modelsByProvider[provider] || []).slice()
      // 目录暂时不完整时保留已保存的选项，不在读取阶段清空用户配置。
      if (provider && !providers.some((item) => item.id === provider)) providers.unshift({ id: provider, name: provider })
      if (model && !models.some((item) => item.id === model)) models.unshift({ id: model, name: model })
      const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14, fontSize: 13, color: colors.secondary }
      const controlStyle = { width: '100%', minWidth: 0, height: 34, padding: '0 10px', border: `1px solid ${colors.border}`, borderRadius: 9, background: colors.panel, color: colors.text, font: 'inherit' }
      return h('section', { 'data-quickchat-settings': true, style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 18, color: colors.text } },
        h('button', { type: 'button', onClick: onBack, style: { border: 'none', background: 'transparent', color: colors.secondary, cursor: 'pointer', padding: '0 0 14px', font: 'inherit', fontSize: 13 } }, `‹ ${t('settingsBack')}`),
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, t('settingsTitle')),
        h('div', { style: { marginTop: 5, color: colors.tertiary, fontSize: 12.5, lineHeight: 1.45 } }, t('settingsDescription')),
        notice ? h('p', { role: 'status' }, t(notice)) : null,
        writeError ? h('p', { role: 'alert' }, t(writeError)) : null,
        catalog.status === 'error' ? h('p', { role: 'status' }, t('settingsModelsUnavailable')) : null,
        h('label', { style: fieldStyle },
          h('span', null, t('settingsProvider')),
          h('select', { value: provider, disabled: disabled || catalog.status !== 'ready', onChange: (event) => write('provider', event.target.value), style: controlStyle },
            h('option', { value: '' }, t('settingsDefaultProvider')),
            providers.map((item) => h('option', { key: item.id, value: item.id }, item.name))
          )
        ),
        h('label', { style: fieldStyle },
          h('span', null, t('settingsModel')),
          h('select', { value: model, disabled: disabled || !provider || catalog.status !== 'ready' || models.length === 0, onChange: (event) => write('model', event.target.value), style: controlStyle },
            h('option', { value: '' }, t(catalog.status === 'loading' ? 'settingsModelsLoading' : 'settingsDefaultModel')),
            models.map((item) => h('option', { key: item.id, value: item.id }, item.name))
          )
        )
      )
    }

    function QuickChatTabBody({ sessionId, useSessions, useWorkspaces, useTabInfo, form, session, t }) {
      const { tab } = useTabInfo()
      const sessions = useSessions((state) => state)
      const workspaces = useWorkspaces((state) => state)
      const context = projectContextForSession(sessions, workspaces, sessionId)
      const [controller] = useState(() => createQuickChatTabController())
      const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot)
      useEffect(() => controller.mount(tab.signal), [controller, tab.signal])
      useEffect(() => { controller.loadProject(context) }, [controller, context.sessionId, context.cwd, context.projectRoot])
      useEffect(() => { if (tab.visible) controller.refresh() }, [controller, tab.visible])
      const remove = (id) => {
        if (window.confirm(t('removeConfirm'))) controller.removeConversation(id)
      }
      return h('div', { 'data-quickchat-tab-body': true, 'data-quickchat-mode': 'tab', 'aria-label': t('quickChat'), style: { height: '100%', width: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: colors.panel, color: colors.text } },
        h(Header, { t, snapshot, controller, onClose: () => tab.actions.close() }),
        snapshot.settingsOpen ? h(QuickChatSettingsView, { form, session, t, onBack: () => controller.store.set({ settingsOpen: false }) }) : h(React.Fragment, null,
          snapshot.currentId ? h(Thread, { snapshot, t, onBack: controller.backToRecent, visible: tab.visible }) : h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'safe flex-end' } },
            h(RecentChats, { snapshot, t, onSelect: controller.selectConversation, onRename: controller.renameConversation, onRemove: remove, onToggle: () => controller.store.set({ expanded: !snapshot.expanded }) })
          ),
          snapshot.error ? h('div', { role: 'alert', style: { flex: 'none', padding: '5px 18px', color: colors.tertiary, fontSize: 12 } }, ['projectUnavailable', 'requestFailed'].includes(snapshot.error) ? t(snapshot.error) : snapshot.error) : null,
          h(Composer, { snapshot, t, controller, visible: tab.visible })
        )
      )
    }

    function QuickChatTabTitle({ t }) {
      return t('quickChat')
    }

    function bindLocale(ctx) {
      if (ctx.locale?.bind) return ctx.locale.bind(NS)
      return (key) => dictionaries.zh[key] || key
    }

    function registerClient(ctx) {
      const t = bindLocale(ctx)
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-quickchat: locale')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: 'dsh-quickchat',
        kind: 'quickchat',
        title: () => t('quickChat'),
        keepMounted: true,
        guide: [{ id: 'panel', order: 40, title: () => t('quickChat'), description: () => t('guideDescription') }],
      }), 'dsh-quickchat: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: 'dsh-quickchat',
        locale: NS,
        inject: () => ({ form: ctx.configForms.get('quickchat'), session: ctx.remote.session }),
      }, QuickChatTabBody)), 'dsh-quickchat: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: 'dsh-quickchat',
        locale: NS,
      }, QuickChatTabTitle)), 'dsh-quickchat: tab title')
    }

    const plugin = {
      name: 'quickchat',
      // sessions/workspaces/sidebarRight 同时为 body 的标准 hooks 与 tab actions 提供服务。
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'remote', 'remote.session', 'configForms', 'sidebarRightTabs', 'sidebarRight'],
      apply: registerClient,
      __test: {
        createQuickChatStore,
        createQuickChatTabController,
        projectContextForSession,
        projectKeyOf,
        createApiClient,
        decodeStreamLine,
        visibleMessages,
        modelCatalogProjection,
        loadModelCatalog,
        settingsSnapshot,
        settingsNotice,
        updateQuickChatSetting,
        isComposingEvent,
        shouldSubmitOnEnter,
        formatDate,
        headerActionStyle,
      },
    }
    return plugin
  },
})
