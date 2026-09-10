import z from '@deepseek-ai/schemastery'

export interface QuickChatRoute {
  provider: string
  model: string
}

export interface QuickChatSettings {
  provider: string
  model: string
}

export interface QuickChatConfig {
  storeRoot?: string
}

export declare const name: 'quickchat'
export declare const inject: readonly ['webServer', 'llm', 'agentDefaultModel']
export declare const QUICKCHAT_SETTINGS_NAMESPACE: 'dsh-quickchat'
export declare const QUICKCHAT_SETTINGS_SCHEMA: z<QuickChatSettings>
export declare function apply(ctx: unknown, config?: QuickChatConfig): void
