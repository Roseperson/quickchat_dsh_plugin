import z from '@deepseek-ai/schemastery'
import { createQuickChatService } from './quickchat-service.js'
import { createRouteHandler, ROUTE_PREFIX } from './route-handler.js'

export const name = 'quickchat'
export const inject = ['webServer', 'llm', 'agentDefaultModel']
export const QUICKCHAT_SETTINGS_NAMESPACE = 'dsh-quickchat'
export const QUICKCHAT_SETTINGS_SCHEMA = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

/**
 * Host half of the DSH WebUI Quick Chat plugin.
 *
 * The route is deliberately project-scoped by the service: the browser may
 * provide the current cwd as context, but the Host canonicalizes it before a
 * chat id is resolved or any file is touched.
 */
export function apply(ctx, config = {}) {
  const service = createQuickChatService({
    ctx,
    storeRoot: config.storeRoot,
  })
  const route = { kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(service) }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.webServer.register(route), 'dsh-quickchat: API')
  } else {
    ctx.webServer.register(route)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, QUICKCHAT_SETTINGS_NAMESPACE, QUICKCHAT_SETTINGS_SCHEMA, {
        provider: '',
        model: '',
      }, {
        setSource: (current) => service.setRouteSettings(current),
        onChange: () => {},
      })
    })
  }
}
