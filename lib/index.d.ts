import z from '@deepseek-ai/schemastery'

export interface QuickChatRoute {
  provider: string
  model: string
}

export interface QuickChatSettings {
  provider: string
  model: string
}

/** profile 中的普通配置输入；provider/model 留空时使用宿主默认模型。 */
export interface QuickChatConfig extends Partial<QuickChatSettings> {
  storeRoot?: string
}

/** Cordis 传给 apply 的运行时配置；Loader 原地更新引用，无需重启插件。 */
export interface QuickChatResolvedConfig {
  provider: { get(): string }
  model: { get(): string }
  storeRoot?: string
}

export declare const name: 'quickchat'
export declare const inject: readonly ['webServer', 'llm', 'agentDefaultModel']
export declare const Config: z<QuickChatConfig, QuickChatResolvedConfig>
export declare function apply(ctx: unknown, config?: QuickChatResolvedConfig): void
