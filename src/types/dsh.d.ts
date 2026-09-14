/** Host 运行时由 DSH 提供的最小编译期声明（与 dsh-automation 相同的 stub 策略）。 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    readonly agent?: any
    readonly agents: any
    readonly sessions: any
    readonly sessionPersistence?: any
    readonly workspaceRegistry: any
    readonly connection: any
    readonly webServer: { register(route: unknown): () => void }
    readonly tools: any
    readonly systemPrompt?: { section(input: { name: string; order: number; text: string }): () => void }
    readonly logger: { warn(message: string): void }
    effect<T>(factory: () => T | Promise<T>, label?: string): T
    on(name: string, listener: (...args: any[]) => any): () => void
    get(name: string): unknown
    setInterval(fn: () => void, ms: number): () => void
  }
}

declare module '@deepseek-ai/dsh-agent' {
  export interface ModelSelection {
    provider: string
    model: string
    reasoningEffort?: string
  }
}

declare module '@deepseek-ai/dsh-client-connection' {}
declare module '@deepseek-ai/dsh-client-locale' {}
declare module '@deepseek-ai/dsh-client-runtime' {}
declare module '@deepseek-ai/dsh-client-ui-conversation' {}
declare module '@deepseek-ai/dsh-client-ui-settings' {}

declare module '@deepseek-ai/dsh-session' {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
  export type SessionId = string & { readonly __sessionId: unique symbol }
  export type SessionHeader = {
    readonly id: SessionId
    readonly cwd?: string
    readonly createdAt?: string
    [key: string]: unknown
  }
  export type SessionEvent = { readonly type: string; readonly data: any; readonly seq: number; readonly time: string }
  export function SessionId(value: string): SessionId
}

declare module '@deepseek-ai/dsh-workspace' {
  export type WorkspaceId = string & { readonly __workspaceId: unique symbol }
  export function WorkspaceId(value: string): WorkspaceId
}

declare module '@deepseek-ai/dsh-tools' {
  import type { JsonValue } from '@deepseek-ai/dsh-session'
  export type { JsonValue } from '@deepseek-ai/dsh-session'
  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly agent?: { readonly id: string }
  }
  export function defineTool(definition: any): any
}

declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react"
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal
}
