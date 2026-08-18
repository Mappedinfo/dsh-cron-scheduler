/** 共享领域类型：定义、运行记录、计划。 */

export type AutomationStatus = 'active' | 'paused'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type RunTrigger = 'schedule' | 'manual'
export type PermissionPreset = 'read-only' | 'workspace-write'

/** 一条定时规则（等价于一条 crontab 部署）。 */
export interface CronDefinition {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly prompt: string
  /** 5 字段 cron 表达式或 @-快捷方式（@reboot/@daily/@hourly/@weekly/@monthly）。 */
  readonly cron: string
  readonly status: AutomationStatus
  readonly workspaceId: string
  readonly cwd: string
  readonly permission: PermissionPreset
  readonly createdAt: string
  readonly updatedAt: string
  readonly deployedAt: string | null
  readonly deployError: string | null
}

/** 一次运行的持久化记录（wrapper 脚本写 JSON，Web 端读取/补全）。 */
export interface RunRecord {
  readonly id: string
  readonly automationId: string
  readonly trigger: RunTrigger
  readonly scheduledFor: string
  readonly status: RunStatus
  readonly sessionId: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly summary: string | null
  readonly error: string | null
  readonly unread: boolean
}

export interface CreateDefinitionRequest {
  readonly name: string
  readonly prompt: string
  readonly cron: string
  readonly cwd: string
  readonly permission: PermissionPreset
}

export interface UpdateDefinitionInput {
  readonly name?: string
  readonly prompt?: string
  readonly cron?: string
  readonly status?: AutomationStatus
  readonly permission?: PermissionPreset
  readonly workspaceId?: string
  readonly cwd?: string
  readonly now?: string
}

export interface CreateRunInput {
  readonly id: string
  readonly automationId: string
  readonly trigger: RunTrigger
  readonly scheduledFor: string
}

/** Cron 校验结果。 */
export type CronValidation = { readonly ok: true; readonly normalized: string } | { readonly ok: false; readonly error: string }
