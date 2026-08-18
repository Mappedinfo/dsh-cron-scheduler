/**
 * 会话监听器：周期性扫描持久化会话，识别 headless 运行产生的会话
 * （首条用户消息含 `[dsh-cron:task=<id>]` 标记），
 * 把它 attach 到规则所属工作区，并把 sessionId/摘要回填到运行记录。
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { DefinitionStore, RunStore } from './storage.ts'

const MARKER = /\[dsh-cron:task=([a-zA-Z0-9-]+)\]/
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const SEEN_TTL_MS = 48 * 60 * 60 * 1000

interface PersistenceLike {
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
  locate(meta: SessionHeader): { readonly path: string } | undefined
  readFrom(id: string, seq: number, signal?: AbortSignal): Promise<{ readonly events: readonly any[] }>
}

export class SessionWatcher {
  private readonly seen = new Map<string, number>()
  private readonly linked = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly definitions: DefinitionStore,
    private readonly runs: RunStore,
  ) {}

  /** 单轮扫描；异常不外抛（watchdog 调用）。 */
  async sweep(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined || typeof persistence.list !== 'function') return
    const definitions = await this.definitions.list().catch(() => [])
    const cwdById = new Map(definitions.map(definition => [definition.id, definition.cwd]))
    if (cwdById.size === 0) return
    const now = Date.now()
    let headers: readonly SessionHeader[]
    try {
      headers = await persistence.list()
    } catch {
      return
    }
    for (const header of headers) {
      const id = String(header.id)
      if (this.linked.has(id) || this.seen.has(id)) continue
      const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
      if (cwd === undefined) continue
      const ruleId = [...cwdById.entries()].find(([, path]) => path === cwd)?.[0]
      if (ruleId === undefined) continue
      const location = persistence.locate(header)
      if (location !== undefined) {
        try {
          const size = (await stat(location.path)).size
          if (size > MAX_ARTIFACT_BYTES) {
            this.seen.set(id, now)
            continue
          }
        } catch {
          // 读不到大小也继续尝试
        }
      }
      try {
        const { events } = await persistence.readFrom(id, 0)
        const marker = this.matchMarker(events)
        if (marker === null) {
          this.seen.set(id, now)
          continue
        }
        await this.attachAndLink(ruleId, id, events)
        this.linked.add(id)
      } catch {
        this.seen.set(id, now)
      }
      this.seen.set(id, now)
    }
    this.prune(now)
  }

  private matchMarker(events: readonly any[]): string | null {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const content = event.data?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue
        const match = MARKER.exec(block.text)
        if (match !== null) return match[1] ?? null
      }
      return null // 第一条用户消息没有标记 → 非本插件会话
    }
    return null
  }

  private async attachAndLink(ruleId: string, sessionId: string, events: readonly any[]): Promise<void> {
    const definitions = await this.definitions.list().catch(() => [])
    const rule = definitions.find(definition => definition.id === ruleId)
    if (rule === undefined) return
    try {
      const workspace = await this.resolveWorkspace(rule.workspaceId, rule.cwd)
      if (workspace === undefined) return
      await workspace.attachSession(SessionId(sessionId))
    } catch (error) {
      this.ctx.logger.warn(`dsh-cron-scheduler: attach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 回填运行记录：找该规则最新一条未链接的进行中/终态记录
    try {
      const runs = await this.runs.list(ruleId)
      const candidate = runs.find(run => run.sessionId === null && (run.status === 'running' || run.status === 'queued'))
        ?? runs.find(run => run.sessionId === null)
      if (candidate === undefined) return
      const summary = lastAssistantText(events)
      await this.runs.update(candidate.id, run => ({
        ...run,
        sessionId,
        ...(summary === null ? {} : { summary }),
        unread: true,
      }))
    } catch (error) {
      this.ctx.logger.warn(`dsh-cron-scheduler: link run for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async resolveWorkspace(workspaceId: string, cwd: string): Promise<{ readonly attachSession: (id: unknown) => Promise<void> } | undefined> {
    const registry = this.ctx.workspaceRegistry as {
      get?(id: string): unknown
      resolveByPath?(path: string): Promise<unknown> | unknown
    }
    const byId = typeof registry?.get === 'function' ? registry.get(workspaceId) : undefined
    const target = byId ?? (typeof registry?.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : undefined)
    const attach = (target as { attachSession?(id: unknown): Promise<void> } | undefined)?.attachSession
    if (typeof attach !== 'function') return undefined
    return { attachSession: attach.bind(target) }
  }

  private prune(now: number): void {
    for (const [id, time] of this.seen) {
      if (now - time > SEEN_TTL_MS) this.seen.delete(id)
    }
  }
}

function lastAssistantText(events: readonly any[]): string | null {
  let last: string | null = null
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('')
    if (text !== '') last = text
  }
  return last
}
