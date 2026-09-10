const MAX_BODY = 64 * 1024

export function createRouteError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  const host = req?.headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw createRouteError(413, 'BODY_TOO_LARGE', 'body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw createRouteError(400, 'INVALID_JSON', 'invalid JSON body')
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

