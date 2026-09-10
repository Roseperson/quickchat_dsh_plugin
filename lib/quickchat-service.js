import { randomUUID } from 'node:crypto'
import { createProjectStore } from './store.js'
import { resolveProjectContext } from './project-domain.js'

export const TITLE_MAX_TOKENS = 64
export const TITLE_MAX_INPUT_BYTES = 4096
export const TITLE_TIMEOUT_MS = 60000
const TITLE_FALLBACK_MAX_WORDS = 5
const TITLE_FALLBACK_MAX_BYTES = 40
const TITLE_MAX_BYTES = 80
export const NATIVE_TITLE_SYSTEM_PROMPT = [
  'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
  'Use the language of the messages.',
  'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
].join('\n')

function serviceError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function publicProject(project) {
  return { id: project.id, title: project.title, root: project.root }
}

function publicMessage(message) {
  if (!message || typeof message !== 'object') return message
  const { reasoning: _reasoning, ...visible } = message
  return visible
}

function projectContext(context) {
  if (!context || typeof context !== 'object') throw serviceError(400, 'CWD_REQUIRED', 'project cwd is required')
  return context
}

function activeKey(project, id) {
  return `${project.id}:${id}`
}

function textOf(message) {
  return typeof message?.text === 'string' ? message.text : ''
}

function estimateTokens(item) {
  return Math.ceil(textOf(item).length / 4) + 8
}

function trimHistory(history, capacity) {
  if (!Number.isFinite(capacity) || capacity <= 0) return { history, dropped: 0 }
  const kept = history.slice()
  let used = kept.reduce((sum, item) => sum + estimateTokens(item), 0)
  let dropped = 0
  while (kept.length > 1 && used > capacity) {
    used -= estimateTokens(kept.shift())
    dropped += 1
  }
  return { history: kept, dropped }
}

function llmMessage(item, route) {
  const role = item.role === 'assistant' ? 'assistant' : 'user'
  return {
    id: randomUUID(),
    role,
    content: [{ type: 'text', text: textOf(item) }],
    source: role === 'user'
      ? { kind: 'user' }
      : { kind: 'model', provider: route.provider, model: item.model ?? route.model },
  }
}

function normalizeGeneratedTitle(value) {
  if (typeof value !== 'string') return ''
  return truncateTitleUtf8(cleanTitleText(value), TITLE_MAX_BYTES).trimEnd()
}

function cleanTitleText(value) {
  return value
    .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function truncateTitleUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let used = 0
  let output = ''
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

function deriveFallbackTitle(value) {
  const cleaned = cleanTitleText(value)
  const words = cleaned.split(' ').filter(Boolean).slice(0, TITLE_FALLBACK_MAX_WORDS).join(' ')
  return truncateTitleUtf8(words, TITLE_FALLBACK_MAX_BYTES).trimEnd()
}

function finishKind(reason) {
  if (reason && typeof reason === 'object') return reason.kind
  return typeof reason === 'string' ? reason : 'stop'
}

function linkAbortSignal(signal, controller) {
  if (!signal) return () => {}
  if (signal.aborted) controller.abort()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function titleInput(text) {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: 0, text }])}`
}

function titleMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  }
}

function routeFields(route) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  }
}

/**
 * Create the Host-side Quick Chat service. Dependencies are injectable so the
 * project and streaming contracts remain testable without a running DSH host.
 */
export function createQuickChatService({
  ctx,
  storeRoot,
  clock = () => Date.now(),
  idFactory = randomUUID,
  projectResolver = resolveProjectContext,
  storeFactory = createProjectStore,
} = {}) {
  if (!ctx?.llm || typeof ctx.llm.stream !== 'function') throw new TypeError('ctx.llm.stream is required')
  const stores = new Map()
  const active = new Map()
  const titleJobs = new Map()
  let settingsRoute = { provider: '', model: '' }
  let settingsRouteSource = null

  function resolveProject(context) {
    const input = projectContext(context)
    try {
      return projectResolver({ cwd: input.cwd, projectRoot: input.projectRoot, storeRoot })
    } catch (error) {
      if (error.status === undefined) error.status = 400
      throw error
    }
  }

  function storeFor(project) {
    let store = stores.get(project.id)
    if (!store) {
      store = storeFactory({ project, clock, idFactory })
      stores.set(project.id, store)
    }
    return store
  }

  function setRouteSettings(next = {}) {
    settingsRouteSource = typeof next === 'function' ? next : null
    const value = settingsRouteSource ? settingsRouteSource() : next
    settingsRoute = {
      provider: typeof value?.provider === 'string' ? value.provider.trim() : '',
      model: typeof value?.model === 'string' ? value.model.trim() : '',
    }
  }

  function currentRouteSettings() {
    if (settingsRouteSource) {
      try {
        setRouteSettings(settingsRouteSource)
      } catch {
        // Keep the last valid settings snapshot while the optional provider recovers.
      }
    }
    return settingsRoute
  }

  function hostDefaultRoute() {
    let defaultModel = ctx.agentDefaultModel
    if (!defaultModel && typeof ctx.get === 'function') {
      try { defaultModel = ctx.get('agentDefaultModel') } catch { /* optional in isolated tests */ }
    }
    try {
      const selection = defaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return {
          provider: String(selection.provider),
          model: String(selection.model),
          ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
        }
      }
    } catch {
      // Fall back to the LLM registry when an optional host service is unavailable.
    }
    return null
  }

  async function validateRoute(route, signal) {
    if (typeof ctx.llm.resolveCallConfig === 'function') {
      await ctx.llm.resolveCallConfig(routeFields(route), signal)
    }
    return route
  }

  async function resolveRoute(signal) {
    const currentSettings = currentRouteSettings()
    if (currentSettings.provider && currentSettings.model) {
      return validateRoute({ provider: currentSettings.provider, model: currentSettings.model }, signal)
    }

    const hostRoute = hostDefaultRoute()
    if (hostRoute) return validateRoute(hostRoute, signal)

    const providers = typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []
    const provider = providers?.[0]?.id
    if (!provider) throw serviceError(503, 'NO_PROVIDER', 'no provider configured')
    const models = typeof ctx.llm.listModels === 'function' ? await ctx.llm.listModels(provider).catch(() => []) : []
    const model = models?.[0]?.id
    if (!model) throw serviceError(503, 'NO_MODEL', `provider "${provider}" has no model`)
    return validateRoute({ provider, model }, signal)
  }

  async function contextWindow(route, signal) {
    if (typeof ctx.llm.resolveModelInfo !== 'function') return 60000
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      return info?.context?.contextWindow ?? 60000
    } catch {
      return 60000
    }
  }

  async function summarizeTitle(route, userText, signal) {
    const framedInput = titleInput(userText)
    if (Buffer.byteLength(framedInput, 'utf8') > TITLE_MAX_INPUT_BYTES) return ''
    let output = ''
    let finish
    try {
      const stream = ctx.llm.stream({
        ...routeFields(route),
        system: NATIVE_TITLE_SYSTEM_PROMPT,
        messages: [titleMessage(framedInput)],
        maxTokens: TITLE_MAX_TOKENS,
        purpose: 'session-title',
        signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'tool-call') return ''
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
        if (chunk?.type === 'finish') {
          finish = chunk.reason
        }
      }
      if (signal?.aborted) return ''
      if (!finish || finishKind(finish) !== 'stop') return ''
      return normalizeGeneratedTitle(output)
    } catch {
      return ''
    }
  }

  function cancelTitle(key) {
    const job = titleJobs.get(key)
    if (!job) return
    titleJobs.delete(key)
    job.controller.abort()
  }

  function startTitleJob({ key, store, id, route, userText, fallbackTitle, onEvent }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    const job = { controller }
    titleJobs.set(key, job)
    const promise = (async () => {
      try {
        const generatedTitle = await summarizeTitle(route, userText, controller.signal)
        if (!generatedTitle || controller.signal.aborted || titleJobs.get(key) !== job) return
        const current = store.get(id)
        if (current.title !== fallbackTitle) return
        const renamed = store.rename(id, generatedTitle)
        onEvent({ type: 'title', title: renamed.title })
      } catch {
        // Automatic title generation is best effort; the local fallback remains.
      } finally {
        clearTimeout(timeout)
        if (titleJobs.get(key) === job) titleJobs.delete(key)
      }
    })()
    return promise
  }

  function list(context) {
    const project = resolveProject(context)
    return { project: publicProject(project), conversations: storeFor(project).list() }
  }

  function create(context, title = '') {
    const project = resolveProject(context)
    return { project: publicProject(project), conversation: storeFor(project).create(title) }
  }

  function get(context, id) {
    const project = resolveProject(context)
    return storeFor(project).get(id)
  }

  function messages(context, id) {
    const project = resolveProject(context)
    return storeFor(project).messages(id).map(publicMessage)
  }

  function rename(context, id, title) {
    const project = resolveProject(context)
    cancelTitle(activeKey(project, id))
    return { conversation: storeFor(project).rename(id, title) }
  }

  function remove(context, id) {
    const project = resolveProject(context)
    cancelTitle(activeKey(project, id))
    return storeFor(project).remove(id)
  }

  function cancel(context, id) {
    const project = resolveProject(context)
    const store = storeFor(project)
    store.get(id)
    const key = activeKey(project, id)
    const entry = active.get(key)
    if (!entry) return { ok: true, active: false }
    entry.controller.abort()
    return { ok: true, active: true }
  }

  async function streamMessage({ context, id, text, onEvent = () => {}, signal } = {}) {
    const project = resolveProject(context)
    const store = storeFor(project)
    const conversation = store.get(id)
    if (typeof text !== 'string' || text.trim() === '') throw serviceError(400, 'TEXT_REQUIRED', 'text required')
    const key = activeKey(project, id)
    if (active.has(key)) throw serviceError(409, 'BUSY', 'conversation is busy')
    cancelTitle(key)

    const controller = new AbortController()
    const unlink = linkAbortSignal(signal, controller)
    active.set(key, { controller })
    let activeReleased = false
    try {
      const userText = text.trim()
      const shouldSummarizeTitle = conversation.title === ''
      const fallbackTitle = deriveFallbackTitle(userText)
      store.appendMessage(id, { role: 'user', text: userText, ts: clock(), status: 'ok' })
      if (shouldSummarizeTitle && fallbackTitle) store.rename(id, fallbackTitle)

      const route = await resolveRoute(controller.signal)
      const history = store.messages(id)
      const capacity = await contextWindow(route, controller.signal)
      const trimmed = trimHistory(history, capacity)
      onEvent({ type: 'meta', conversation: store.get(id), route, dropped: trimmed.dropped })

      let output = ''
      let status = 'ok'
      let errorInfo = null
      try {
        const stream = ctx.llm.stream({
          ...routeFields(route),
          messages: trimmed.history.map((item) => llmMessage(item, route)),
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') {
            const value = typeof chunk.text === 'string' ? chunk.text : ''
            output += value
            if (value) onEvent({ type: 'delta', text: value })
          } else if (chunk?.type === 'finish') {
            const kind = finishKind(chunk.reason)
            if (kind === 'aborted') status = 'aborted'
            else if (kind !== 'stop' && kind !== 'max-tokens') {
              status = 'error'
              const failure = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason.failure : undefined
              errorInfo = {
                code: failure?.code ?? `FINISH_${String(kind).toUpperCase()}`,
                message: failure?.message ?? `generation ended with reason ${kind}`,
              }
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) status = 'aborted'
        else {
          status = 'error'
          errorInfo = { code: error?.code ?? 'LLM_ERROR', message: error?.message ?? String(error) }
        }
      }

      const assistant = {
        role: 'assistant',
        text: output,
        ts: clock(),
        model: route.model,
        status,
        ...(errorInfo ? { error: errorInfo.message } : {}),
      }
      store.appendMessage(id, assistant)
      if (errorInfo) onEvent({ type: 'error', code: errorInfo.code, message: errorInfo.message })

      const titlePromise = shouldSummarizeTitle && status === 'ok'
        ? startTitleJob({ key, store, id, route, userText, fallbackTitle, onEvent })
        : null
      active.delete(key)
      activeReleased = true
      const message = { ...assistant }
      onEvent({ type: 'done', message, aborted: status === 'aborted' })
      if (shouldSummarizeTitle && status === 'ok') {
        await titlePromise
      }
      return { status, message, route, dropped: trimmed.dropped }
    } finally {
      unlink()
      if (!activeReleased && active.get(key)?.controller === controller) active.delete(key)
    }
  }

  return {
    list,
    create,
    get,
    messages,
    rename,
    remove,
    cancel,
    streamMessage,
    setRouteSettings,
  }
}
