/** 客户端状态源：RPC 拉取 + 订阅。 */

import type { ClientRpc } from './contracts.js'
import type { SnapshotView } from './contracts.js'
import { unwrapRpcResult } from './protocol.js'

const CHANNEL = '/dsh-cron-scheduler'

export interface CronClientState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly snapshot?: SnapshotView
  readonly error?: string
}

export interface CronStateSource {
  getSnapshot(): CronClientState
  subscribe(listener: () => void): () => void
}

export interface CronRuntime {
  readonly source: CronStateSource
  refresh(): Promise<void>
  createAutomation(input: {
    readonly name: string
    readonly prompt: string
    readonly cron: string
    readonly cwd: string
    readonly permission: 'read-only' | 'workspace-write'
  }): Promise<void>
  mutateAutomation(automationId: string, mutation: 'pause' | 'resume' | 'delete'): Promise<void>
  updateAutomation(automationId: string, input: Partial<{
    readonly name: string
    readonly prompt: string
    readonly cron: string
    readonly cwd: string
    readonly permission: 'read-only' | 'workspace-write'
  }>): Promise<void>
  runNow(automationId: string): Promise<void>
}

export function createCronRuntime(rpc: ClientRpc): CronRuntime {
  let state: CronClientState = { phase: 'idle' }
  let refreshPromise: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: CronClientState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const source: CronStateSource = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const refresh = async (): Promise<void> => {
    if (refreshPromise !== undefined) return refreshPromise
    const previous = state.snapshot
    publish(previous === undefined ? { phase: 'loading' } : { phase: 'loading', snapshot: previous })
    refreshPromise = (async () => {
      try {
        const response = await rpc.call(CHANNEL, 'snapshot', {})
        const snapshot = unwrapRpcResult<SnapshotView>(response)
        publish({ phase: 'ready', snapshot })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        publish(previous === undefined
          ? { phase: 'error', error: message }
          : { phase: 'error', snapshot: previous, error: message })
        throw error
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  const callRpc = async (endpoint: string, payload: unknown): Promise<unknown> => {
    try {
      return await rpc.call(CHANNEL, endpoint, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/failed to fetch|networkerror|load failed|network request failed/i.test(message)) throw error
      return await rpc.call(CHANNEL, endpoint, payload)
    }
  }

  const mutateThenRefresh = async (endpoint: string, payload: unknown): Promise<void> => {
    unwrapRpcResult<unknown>(await callRpc(endpoint, payload))
    const pendingBeforeRefresh = refreshPromise
    if (pendingBeforeRefresh !== undefined) await pendingBeforeRefresh.catch(() => undefined)
    try {
      await refresh()
    } catch {
      // 变更已生效；刷新失败不应让用户以为操作没成功。
    }
  }

  return {
    source,
    refresh,
    async createAutomation(input) {
      await mutateThenRefresh('create', { input })
    },
    async mutateAutomation(automationId, mutation) {
      await mutateThenRefresh('mutate', { automationId, mutation })
    },
    async updateAutomation(automationId, input) {
      await mutateThenRefresh('update', { automationId, input })
    },
    async runNow(automationId) {
      await mutateThenRefresh('run-now', { automationId })
    },
  }
}
