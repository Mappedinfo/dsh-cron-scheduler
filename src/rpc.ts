/** 仅 loopback 的 Web 客户端 RPC 适配器。 */

import type { CronSchedulerService } from './service.ts'
import type { PermissionPreset } from './types.ts'

interface RpcContext {
  readonly connection: {
    readonly rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
        options: { readonly authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function errorResult(error: unknown): { readonly ok: false; readonly error: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error)
  const badRequest = /不能为空|必须是|超出范围|需要 5 个字段|未注册|不存在|无法确定|至少需要|已取消|步长|范围|无法识别|表达式/.test(message)
  return {
    ok: false,
    error: {
      code: badRequest ? 'bad-request' : 'internal',
      message,
      details: badRequest ? { issues: [] } : {},
    },
  }
}

function permissionOf(value: unknown): PermissionPreset {
  if (value !== 'read-only' && value !== 'workspace-write') throw new Error('permission 必须是 read-only 或 workspace-write')
  return value
}

export function registerAutomationRpc(ctx: RpcContext, service: CronSchedulerService): () => Promise<void> {
  return ctx.connection.rpc.handle('/dsh-cron-scheduler', async (endpoint, rawPayload, signal) => {
    try {
      const payload = record(rawPayload, 'payload')
      switch (endpoint) {
        case 'snapshot': {
          const snapshot = await service.snapshot()
          return { ok: true, value: snapshot }
        }
        case 'create': {
          const input = record(payload.input, 'input')
          const created = await service.create({
            name: string(input.name, 'name'),
            prompt: string(input.prompt, 'prompt'),
            cron: string(input.cron, 'cron'),
            cwd: string(input.cwd, 'cwd'),
            permission: permissionOf(input.permission ?? 'read-only'),
          }, signal)
          return { ok: true, value: { id: created.id } }
        }
        case 'mutate': {
          const id = string(payload.automationId, 'automationId')
          const mutation = string(payload.mutation, 'mutation')
          if (mutation === 'delete') {
            return { ok: true, value: await service.delete(id, signal) }
          }
          if (mutation !== 'pause' && mutation !== 'resume') {
            throw new Error('mutation 必须是 pause、resume 或 delete')
          }
          const value = await service.update(id, { status: mutation === 'pause' ? 'paused' : 'active' }, signal)
          return { ok: true, value: { id: value.id, revision: value.revision } }
        }
        case 'update': {
          const id = string(payload.automationId, 'automationId')
          const input = record(payload.input, 'input')
          const updateInput: {
            name?: string
            prompt?: string
            cron?: string
            cwd?: string
            permission?: PermissionPreset
          } = {}
          const name = optionalString(input.name, 'name')
          const prompt = optionalString(input.prompt, 'prompt')
          const cron = optionalString(input.cron, 'cron')
          const cwd = optionalString(input.cwd, 'cwd')
          if (name !== undefined) updateInput.name = name
          if (prompt !== undefined) updateInput.prompt = prompt
          if (cron !== undefined) updateInput.cron = cron
          if (cwd !== undefined) updateInput.cwd = cwd
          if (input.permission !== undefined) updateInput.permission = permissionOf(input.permission)
          const value = await service.update(id, updateInput, signal)
          return { ok: true, value: { id: value.id, revision: value.revision } }
        }
        case 'run-now': {
          const run = await service.runNow(string(payload.automationId, 'automationId'), signal)
          return { ok: true, value: { runId: run.runId } }
        }
        default:
          throw new Error(`unknown endpoint '${endpoint}'`)
      }
    } catch (error) {
      return errorResult(error)
    }
  }, { authority: 'loopback' })
}
