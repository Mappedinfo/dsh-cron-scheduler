/**
 * 基于 JSON 文件的存储：规则定义由 Web 端独占读写；
 * 运行记录由 wrapper 脚本（进程外）写入，Web 端只读并补全 sessionId/summary。
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CronDefinition, RunRecord } from './types.ts'
import type { PluginPaths } from './home.ts'

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export class DefinitionStore {
  constructor(private readonly paths: PluginPaths) {}

  async ensure(): Promise<void> {
    await mkdir(this.paths.definitions, { recursive: true })
  }

  async list(): Promise<CronDefinition[]> {
    let entries: string[]
    try {
      entries = await readdir(this.paths.definitions)
    } catch {
      return []
    }
    const definitions: CronDefinition[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const text = await readFile(join(this.paths.definitions, entry), 'utf8').catch(() => '')
      const value = safeJson<CronDefinition>(text)
      if (value === undefined || value.version !== 1) continue
      definitions.push(value)
    }
    return definitions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(id: string): Promise<CronDefinition | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined
    const text = await readFile(join(this.paths.definitions, `${id}.json`), 'utf8').catch(() => '')
    const value = safeJson<CronDefinition>(text)
    return value?.version === 1 ? value : undefined
  }

  async put(definition: CronDefinition): Promise<void> {
    await this.ensure()
    await atomicWrite(join(this.paths.definitions, `${definition.id}.json`), definition)
  }

  async delete(id: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return false
    try {
      await rm(join(this.paths.definitions, `${id}.json`), { force: false })
      return true
    } catch {
      return false
    }
  }
}

export class RunStore {
  constructor(private readonly paths: PluginPaths) {}

  async ensure(): Promise<void> {
    await mkdir(this.paths.runs, { recursive: true })
  }

  async list(automationId?: string): Promise<RunRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.paths.runs)
    } catch {
      return []
    }
    const runs: RunRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const text = await readFile(join(this.paths.runs, entry), 'utf8').catch(() => '')
      const value = safeJson<RunRecord>(text)
      if (value === undefined || typeof value.id !== 'string') continue
      if (automationId !== undefined && value.automationId !== automationId) continue
      runs.push(value)
    }
    return runs.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor))
  }

  async get(id: string): Promise<RunRecord | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined
    const text = await readFile(join(this.paths.runs, `${id}.json`), 'utf8').catch(() => '')
    return safeJson<RunRecord>(text)
  }

  /** 读-改-写合并（原子替换），避免与 wrapper 并发写互相覆盖。 */
  async update(id: string, transform: (current: RunRecord) => RunRecord): Promise<RunRecord | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined
    const current = await this.get(id)
    if (current === undefined) return undefined
    const next = transform(current)
    await atomicWrite(join(this.paths.runs, `${id}.json`), next)
    return next
  }

  /** 裁剪某规则的过期运行记录（保留最新的 limit 条）。 */
  async prune(automationId: string, limit: number): Promise<void> {
    const runs = await this.list(automationId)
    const terminal = runs.filter(run => run.status !== 'queued' && run.status !== 'running')
    if (terminal.length <= limit) return
    const drop = new Set(terminal.slice(limit).map(run => run.id))
    for (const id of drop) {
      if (!/^[a-zA-Z0-9-]+$/.test(id)) continue
      await rm(join(this.paths.runs, `${id}.json`), { force: true }).catch(() => undefined)
    }
  }
}
