import z from '@deepseek-ai/schemastery'
import { createQuickChatService } from './quickchat-service.js'
import { createRouteHandler, ROUTE_PREFIX } from './route-handler.js'

export const name = 'quickchat'
export const inject = ['webServer', 'llm', 'agentDefaultModel']
export const Config = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  storeRoot: z.string(),
})

/**
 * Quick Chat 宿主入口。浏览器提供 cwd 后，由服务规范化项目路径，
 * 再解析对话或访问文件，保持项目级存储边界。
 */
export function apply(ctx, config = Config()) {
  const service = createQuickChatService({
    ctx,
    storeRoot: config.storeRoot,
  })
  // Cordis 的函数式 apply 与类插件一样接收 Config 解析后的 volatile 引用。
  service.setRouteSettings(() => ({
    provider: config.provider.get(),
    model: config.model.get(),
  }))
  const route = { kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(service) }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.webServer.register(route), 'dsh-quickchat: API')
  } else {
    ctx.webServer.register(route)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => {
      // 自定义表单由 quickchat header 消费；策略归属父插件，随可选服务清理。
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }
}
