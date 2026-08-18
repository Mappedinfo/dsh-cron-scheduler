import type { ComponentType } from 'react'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export interface ClientRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface SlotRegisterOptions {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  readonly label?: () => string
  readonly icon?: string
  readonly priority?: number
}

export interface ClientContext {
  effect(factory: () => void | (() => void), label?: string): void
  connection: { readonly rpc: ClientRpc }
  sessions?: {
    open(id: string): void
    refresh?: () => Promise<void>
  }
  locale: {
    register(namespace: string, dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> }): () => void
    bind(namespace: string): Translate
  }
  slots: {
    inject(name: string, register: () => void | (() => void)): void
    register(options: SlotRegisterOptions, component: ComponentType<any>): () => void
  }
}

export interface SnapshotView {
  readonly generatedAt: string
  readonly workspaces: readonly { readonly id: string; readonly title: string; readonly path: string }[]
  readonly definitions: readonly DefinitionView[]
  readonly runs: readonly RunView[]
  readonly dsh: { readonly command: string; readonly source: string }
}

export interface DefinitionView {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly prompt: string
  readonly cron: string
  readonly status: 'active' | 'paused'
  readonly workspaceId: string
  readonly cwd: string
  readonly permission: 'read-only' | 'workspace-write'
  readonly createdAt: string
  readonly updatedAt: string
  readonly deployedAt: string | null
  readonly deployError: string | null
  readonly nextRunAt: string | null
  readonly lastRunAt: string | null
  readonly lastRunStatus: string | null
  readonly runCount: number
}

export interface RunView {
  readonly id: string
  readonly automationId: string
  readonly trigger: 'schedule' | 'manual'
  readonly scheduledFor: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  readonly sessionId: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly summary: string | null
  readonly error: string | null
  readonly unread: boolean
}

export interface CreateInput {
  readonly name: string
  readonly prompt: string
  readonly cron: string
  readonly cwd: string
  readonly permission: 'read-only' | 'workspace-write'
}
