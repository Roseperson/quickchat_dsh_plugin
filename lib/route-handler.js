import { createRouteError, readJson, sameOrigin, sendJson } from './http.js'

export const ROUTE_PREFIX = '/quickchat/api'

function routeStatus(error) {
  if (Number.isInteger(error?.status)) return error.status
  switch (error?.code) {
    case 'CROSS_ORIGIN': return 403
    case 'NOT_FOUND': return 404
    case 'BUSY': return 409
    case 'NO_PROVIDER':
    case 'NO_MODEL': return 503
    case 'INTERNAL': return 500
    default: return 400
  }
}

function pathSegments(pathname) {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return null
  const rest = pathname.slice(ROUTE_PREFIX.length)
  try {
    return rest.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    throw createRouteError(400, 'INVALID_PATH', 'invalid URL path')
  }
}

function contextFrom(url, body) {
  return {
    cwd: body?.cwd ?? url.searchParams.get('cwd') ?? undefined,
    projectRoot: body?.projectRoot ?? url.searchParams.get('projectRoot') ?? undefined,
  }
}

function streamHeaders(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  })
}

export function createRouteHandler(service) {
  if (!service) throw new TypeError('quickchat service is required')

  return async function handle(req, res) {
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden', code: 'CROSS_ORIGIN' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = pathSegments(url.pathname)
      if (segments === null) {
        sendJson(res, 404, { error: 'no such quickchat route', code: 'NOT_FOUND' })
        return
      }
      const method = req.method ?? 'GET'
      const needsBody = method !== 'GET'
      const body = needsBody ? await readJson(req) : {}
      const context = contextFrom(url, body)

      if (segments.length === 1 && segments[0] === 'conversations') {
        if (method === 'GET') {
          sendJson(res, 200, service.list(context))
          return
        }
        if (method === 'POST') {
          sendJson(res, 200, service.create(context, body.title))
          return
        }
      }

      if (segments.length >= 2 && segments[0] === 'conversations') {
        const id = segments[1]
        const sub = segments.slice(2).join('/')
        if (sub === '' && method === 'PATCH') {
          sendJson(res, 200, service.rename(context, id, body.title))
          return
        }
        if (sub === '' && method === 'DELETE') {
          sendJson(res, 200, service.remove(context, id))
          return
        }
        if (sub === 'messages' && method === 'GET') {
          sendJson(res, 200, { messages: service.messages(context, id) })
          return
        }
        if (sub === 'cancel' && method === 'POST') {
          sendJson(res, 200, service.cancel(context, id))
          return
        }
        if (sub === 'messages' && method === 'POST') {
          let started = false
          const emit = (event) => {
            if (!started) {
              streamHeaders(res)
              started = true
            }
            res.write(`${JSON.stringify(event)}\n`)
            res.flush?.()
          }
          const requestController = new AbortController()
          const abort = () => requestController.abort()
          req.on?.('aborted', abort)
          const result = await service.streamMessage({
            context,
            id,
            text: body.text,
            onEvent: emit,
            signal: requestController.signal,
          })
          if (started) res.end()
          else sendJson(res, 200, result)
          return
        }
      }

      sendJson(res, 404, { error: 'no such quickchat route', code: 'NOT_FOUND' })
    } catch (error) {
      const status = routeStatus(error)
      const code = error?.code ?? 'INTERNAL'
      const message = status >= 500 ? 'internal error' : error?.message ?? String(error)
      if (!res.headersSent) sendJson(res, status, { error: message, code })
      else {
        try { res.write(`${JSON.stringify({ type: 'error', code, message })}\n`) } catch { /* disconnected client */ }
        try { res.end() } catch { /* disconnected client */ }
      }
    }
  }
}
