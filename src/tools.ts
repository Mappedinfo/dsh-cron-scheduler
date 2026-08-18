/** 绑定到单个 root Agent 工作区的管理工具。 */

import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AUTOMATION_PROMPT_TEXT } from './prompt.ts'
import type { CronSchedulerService } from './service.ts'
import type { PermissionPreset } from './types.ts'

interface ToolAgent {
  readonly id: string
  readonly ctx: {
    readonly tools: { register(definition: unknown): () => void }
  }
}

interface CreateArgs {
  readonly name: string
  readonly prompt: string
  readonly cron: string
  readonly cwd?: string
  readonly permission?: PermissionPreset
}

interface UpdateArgs {
  readonly id: string
  readonly name?: string
  readonly prompt?: string
  readonly cron?: string
  readonly status?: 'active' | 'paused'
  readonly cwd?: string
  readonly permission?: PermissionPreset
}

interface IdArgs { readonly id: string }

function render(_args: unknown, value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render,
} as const

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown) {
  return { card: 'generic' as const, title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

export function registerAutomationTools(service: CronSchedulerService, agent: ToolAgent): () => void {
  const disposers: Array<() => void> = []
  const register = (definition: unknown): void => { disposers.push(agent.ctx.tools.register(definition)) }
  try {
    register(defineTool({
      name: 'automation_create',
      description: '创建一条系统级 cron 定时任务。cron 为 5 字段表达式（分 时 日 月 周），支持 */步长、-范围、,列表、月份/星期名称与 @reboot/@daily/@hourly/@weekly/@monthly。不提供 cwd 时使用当前会话工作区。',
      parameters: {
        name: { type: 'string', required: true },
        prompt: { type: 'string', required: true, description: '每次独立运行都使用的自包含任务说明。' },
        cron: { type: 'string', required: true, description: '5 字段 cron 表达式或 @-快捷方式。' },
        cwd: { type: 'string', description: '运行工作区目录，缺省为当前会话工作区。' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write'] },
      },
      output: JSON_OUTPUT,
      async execute(args: CreateArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const cwd = args.cwd ?? await service.resolveScopeCwd(String(agent.id))
          const value = await service.create({
            name: args.name,
            prompt: args.prompt,
            cron: args.cron,
            cwd,
            permission: args.permission ?? 'read-only',
          }, exec.signal)
          return json({ ok: true, automation: value })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: CreateArgs) => present('创建定时任务', 'other', args.name),
    }))

    register(defineTool({
      name: 'automation_list',
      description: '列出所有定时任务规则、下次运行时间、部署状态与最近一次结果。',
      parameters: {},
      output: JSON_OUTPUT,
      async execute(_args: Record<string, never>, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const snapshot = await service.snapshot()
          return json({
            ok: true,
            generatedAt: snapshot.generatedAt,
            automations: snapshot.definitions.map(definition => ({
              id: definition.id,
              name: definition.name,
              cron: definition.cron,
              status: definition.status,
              cwd: definition.cwd,
              permission: definition.permission,
              nextRunAt: definition.nextRunAt,
              lastRunAt: definition.lastRunAt,
              lastRunStatus: definition.lastRunStatus,
              deployedAt: definition.deployedAt,
              deployError: definition.deployError,
            })),
          })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: () => present('列出定时任务', 'read'),
    }))

    register(defineTool({
      name: 'automation_update',
      description: '更新一条定时任务的名称、任务说明、cron、工作区、权限或暂停/恢复状态。仅暂停或恢复不需要其他字段。',
      parameters: {
        id: { type: 'string', required: true },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cron: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] },
        cwd: { type: 'string' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write'] },
      },
      output: JSON_OUTPUT,
      async execute(args: UpdateArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const input: {
            name?: string
            prompt?: string
            cron?: string
            status?: 'active' | 'paused'
            cwd?: string
            permission?: PermissionPreset
          } = {}
          if (args.name !== undefined) input.name = args.name
          if (args.prompt !== undefined) input.prompt = args.prompt
          if (args.cron !== undefined) input.cron = args.cron
          if (args.status !== undefined) input.status = args.status
          if (args.permission !== undefined) input.permission = args.permission
          if (args.cwd !== undefined) input.cwd = args.cwd
          if (Object.keys(input).length === 0) throw new Error('automation_update 至少需要一个变更字段')
          const value = await service.update(args.id, input, exec.signal)
          return json({ ok: true, automation: value })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: UpdateArgs) => present('更新定时任务', 'other', args.id),
    }))

    register(defineTool({
      name: 'automation_runs',
      description: '读取定时任务的运行历史，包括状态、触发方式、结果会话 id 与错误。',
      parameters: {},
      output: JSON_OUTPUT,
      async execute(_args: Record<string, never>, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const snapshot = await service.snapshot()
          return json({ ok: true, generatedAt: snapshot.generatedAt, runs: snapshot.runs })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: () => present('读取运行历史', 'read'),
    }))

    register(defineTool({
      name: 'automation_run_now',
      description: '立即执行一次已有定时任务（使用全新会话与规则保存的权限）。',
      parameters: { id: { type: 'string', required: true } },
      output: JSON_OUTPUT,
      async execute(args: IdArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          return json({ ok: true, run: await service.runNow(args.id, exec.signal) })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: IdArgs) => present('立即运行定时任务', 'other', args.id),
    }))

    register(defineTool({
      name: 'automation_delete',
      description: '删除定时任务定义并从 crontab 移除部署；运行历史保留用于审计。',
      parameters: { id: { type: 'string', required: true } },
      output: JSON_OUTPUT,
      async execute(args: IdArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          return json({ ok: true, value: await service.delete(args.id, exec.signal) })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: IdArgs) => present('删除定时任务', 'other', args.id),
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export { AUTOMATION_PROMPT_TEXT }
