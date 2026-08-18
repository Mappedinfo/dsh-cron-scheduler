/** 服务门面：定义 CRUD + 部署 + 运行 + 快照。 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { validateCron, nextCronRun, normalizeCron } from './cron.ts'
import { syncDeployments, spawnWrapper } from './deploy.ts'
import { resolveDshCommand } from './dsh-resolve.ts'
import { pluginBaseDir, pluginPaths, resolveDshHome, type PluginPaths } from './home.ts'
import { DefinitionStore, RunStore } from './storage.ts'
import type {
  CronDefinition, CreateDefinitionRequest, RunRecord, UpdateDefinitionInput,
} from './types.ts'

export interface ServiceConfig {
  readonly dshCommand: string | undefined
  readonly profile: string
  readonly pollSeconds: number
  readonly historyLimit: number
}

export interface WorkspaceOption {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface Snapshot {
  readonly generatedAt: string
  readonly workspaces: readonly WorkspaceOption[]
  readonly definitions: readonly DefinitionView[]
  readonly runs: readonly RunRecord[]
  readonly dsh: { readonly command: string; readonly source: string }
}

export interface DefinitionView extends CronDefinition {
  readonly nextRunAt: string | null
  readonly lastRunAt: string | null
  readonly lastRunStatus: RunRecord['status'] | null
  readonly runCount: number
}

export class CronSchedulerService {
  readonly paths: PluginPaths
  readonly definitions: DefinitionStore
  readonly runs: RunStore
  private operationTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly config: ServiceConfig,
  ) {
    this.paths = pluginPaths(pluginBaseDir(resolveDshHome()))
    this.definitions = new DefinitionStore(this.paths)
    this.runs = new RunStore(this.paths)
  }

  async start(): Promise<void> {
    await this.definitions.ensure()
    await this.runs.ensure()
    await this.recoverInterruptedRuns()
    await this.cleanStaleLocks()
    const loaded = await this.definitions.list()
    await this.redeployAll(loaded)
  }

  /** wrapper 被中断（进程被杀/崩溃）会留下永远 running 的记录；启动时收尾为 failed。 */
  private async recoverInterruptedRuns(): Promise<void> {
    const staleMs = 60 * 60 * 1000
    const now = Date.now()
    for (const run of await this.runs.list()) {
      if (run.status !== 'running' && run.status !== 'queued') continue
      const started = Date.parse(run.startedAt ?? run.scheduledFor)
      if (Number.isNaN(started) || now - started < staleMs) continue
      const finishedAt = new Date().toISOString()
      await this.runs.update(run.id, current => ({
        ...current,
        status: 'failed',
        finishedAt,
        error: current.error ?? 'host_interrupted：wrapper 运行被中断，未写入终态',
        unread: true,
      }))
    }
  }

  /** 清理陈旧锁（wrapper 被 SIGKILL 时 EXIT trap 不会执行）。 */
  private async cleanStaleLocks(): Promise<void> {
    const staleMs = 24 * 60 * 60 * 1000
    const { readdir, stat, rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    let entries: string[]
    try {
      entries = await readdir(this.paths.locks)
    } catch {
      return
    }
    const now = Date.now()
    for (const entry of entries) {
      try {
        const info = await stat(join(this.paths.locks, entry))
        if (now - info.mtimeMs > staleMs) {
          await rm(join(this.paths.locks, entry), { recursive: true, force: true })
        }
      } catch {
        // 单个锁清理失败不阻塞启动
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async redeployAll(loaded?: readonly CronDefinition[]): Promise<void> {
    const definitions = loaded ?? await this.definitions.list()
    const results = await syncDeployments(definitions, {
      paths: this.paths,
      dshHome: resolveDshHome(),
      dshCommand: this.config.dshCommand,
      profile: this.config.profile,
    })
    for (const definition of definitions) {
      const result = results.get(definition.id)
      if (result === undefined) continue
      const next: CronDefinition = {
        ...definition,
        deployedAt: result.deployedAt,
        deployError: result.error,
      }
      await this.definitions.put(next)
    }
  }

  async create(
    input: CreateDefinitionRequest,
    signal?: AbortSignal,
  ): Promise<CronDefinition> {
    if (signal?.aborted) throw new Error('请求已取消')
    const validation = validateCron(input.cron)
    if (!validation.ok) throw new Error(validation.error)
    const target = await this.resolveWorkspace(input.cwd)
    const id = `task-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const definition: CronDefinition = {
      version: 1,
      id,
      revision: 1,
      name: requireNonBlank(input.name, '名称'),
      prompt: requireNonBlank(input.prompt, '任务说明'),
      cron: validation.normalized,
      status: 'active',
      workspaceId: target.id,
      cwd: target.path,
      permission: input.permission,
      createdAt: now,
      updatedAt: now,
      deployedAt: null,
      deployError: null,
    }
    await this.serialize(async () => {
      await this.definitions.put(definition)
      await this.redeployAll()
    })
    const stored = await this.definitions.get(id)
    return stored ?? definition
  }

  async update(
    id: string,
    input: UpdateDefinitionInput,
    signal?: AbortSignal,
  ): Promise<CronDefinition> {
    if (signal?.aborted) throw new Error('请求已取消')
    const current = await this.definitions.get(id)
    if (current === undefined) throw new Error('自动化不存在')
    let cron = current.cron
    if (input.cron !== undefined) {
      const validation = validateCron(input.cron)
      if (!validation.ok) throw new Error(validation.error)
      cron = validation.normalized
    }
    let workspaceId = current.workspaceId
    let cwd = current.cwd
    if (input.cwd !== undefined && input.cwd !== current.cwd) {
      const target = await this.resolveWorkspace(input.cwd)
      workspaceId = target.id
      cwd = target.path
    } else if (input.workspaceId !== undefined && input.workspaceId !== current.workspaceId) {
      const workspace = await this.getWorkspaceById(input.workspaceId)
      workspaceId = workspace.id
      cwd = workspace.path
    }
    const next: CronDefinition = {
      ...current,
      revision: current.revision + 1,
      name: input.name === undefined ? current.name : requireNonBlank(input.name, '名称'),
      prompt: input.prompt === undefined ? current.prompt : requireNonBlank(input.prompt, '任务说明'),
      cron,
      status: input.status ?? current.status,
      permission: input.permission ?? current.permission,
      workspaceId,
      cwd,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    await this.serialize(async () => {
      await this.definitions.put(next)
      await this.redeployAll()
    })
    return next
  }

  async delete(id: string, signal?: AbortSignal): Promise<{ readonly deleted: boolean }> {
    if (signal?.aborted) throw new Error('请求已取消')
    const current = await this.definitions.get(id)
    if (current === undefined) return { deleted: false }
    await this.serialize(async () => {
      await this.definitions.delete(id)
      await this.redeployAll()
    })
    return { deleted: true }
  }

  async runNow(id: string, signal?: AbortSignal): Promise<{ readonly runId: string | null }> {
    if (signal?.aborted) throw new Error('请求已取消')
    const current = await this.definitions.get(id)
    if (current === undefined) throw new Error('自动化不存在')
    const result = await spawnWrapper(this.paths, id, 'manual')
    if (result.error !== null) throw new Error(result.error)
    await this.runs.prune(id, this.config.historyLimit)
    return { runId: result.runId }
  }

  async snapshot(): Promise<Snapshot> {
    const definitions = await this.definitions.list()
    const runs = await this.runs.list()
    const runById = new Map(runs.map(run => [run.automationId, run]))
    const dsh = resolveDshInfo(this.config.dshCommand, this.paths)
    const views: DefinitionView[] = definitions.map(definition => {
      const latest = runById.get(definition.id)
      const nextRunAt = definition.status === 'active' ? nextCronRun(definition.cron) : null
      return {
        ...definition,
        nextRunAt,
        lastRunAt: latest?.startedAt ?? latest?.scheduledFor ?? null,
        lastRunStatus: latest?.status ?? null,
        runCount: runs.filter(run => run.automationId === definition.id).length,
      }
    })
    return {
      generatedAt: new Date().toISOString(),
      workspaces: await this.collectWorkspaces(),
      definitions: views,
      runs,
      dsh,
    }
  }

  private async collectWorkspaces(): Promise<WorkspaceOption[]> {
    const registry = this.ctx.workspaceRegistry as {
      list?: () => Iterable<unknown>
      values?: () => Iterable<unknown>
      entries?: () => Iterable<[string, unknown]>
    }
    const raw = registry.list !== undefined
      ? [...registry.list()]
      : registry.values !== undefined
        ? [...registry.values()]
        : registry.entries !== undefined
          ? [...registry.entries()].map(([, value]) => value)
          : []
    return raw
      .map((item: any) => ({
        id: String(item.id ?? item.workspaceId ?? ''),
        title: String(item.title ?? item.name ?? item.id ?? item.path ?? ''),
        path: String(item.path ?? item.cwd ?? ''),
      }))
      .filter(item => item.id !== '' && item.path !== '')
  }

  private async resolveWorkspace(cwd: string): Promise<WorkspaceOption> {
    const path = cwd.trim()
    if (path === '') throw new Error('请输入工作区目录')
    const registry = this.ctx.workspaceRegistry as {
      resolveByPath?: (path: string) => Promise<unknown> | unknown
      create?: (path: string, title?: string) => Promise<unknown> | unknown
    }
    const resolved = typeof registry.resolveByPath === 'function'
      ? await registry.resolveByPath(path)
      : undefined
    if (resolved !== undefined) {
      return {
        id: String((resolved as any).id ?? ''),
        title: String((resolved as any).title ?? (resolved as any).name ?? path),
        path: String((resolved as any).path ?? path),
      }
    }
    if (typeof registry.create === 'function') {
      const created = await registry.create(path)
      if (created !== undefined && created !== null) {
        return {
          id: String((created as any).id ?? ''),
          title: String((created as any).title ?? (created as any).name ?? path),
          path: String((created as any).path ?? path),
        }
      }
    }
    throw new Error('工作区未注册且无法创建，请先在 Web 中连接该目录')
  }

  private async getWorkspaceById(workspaceId: string): Promise<WorkspaceOption> {
    const workspaces = await this.collectWorkspaces()
    const workspace = workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new Error('工作区不存在')
    return workspace
  }

  /** Agent 会话所在工作区（工具调用缺省目标）。 */
  async resolveScopeCwd(sessionId: string): Promise<string> {
    const session = this.ctx.sessions?.get?.(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    const agent = this.ctx.agents?.get?.(sessionId)
    const agentCwd = agent?.session?.header?.cwd
    if (typeof agentCwd === 'string' && agentCwd !== '') return agentCwd
    throw new Error('无法确定当前工作区')
  }

  async dispose(): Promise<void> {
    // 无长驻资源；await 排空串行队列
    await this.operationTail
  }
}

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${field} 不能为空`)
  return trimmed
}

function resolveDshInfo(explicit: string | undefined, paths: PluginPaths): { readonly command: string; readonly source: string } {
  const resolution = resolveDshCommand(explicit, paths)
  return { command: resolution.command, source: resolution.source }
}

export { normalizeCron }
