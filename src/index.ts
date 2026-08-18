/** dsh-cron-scheduler Host 插件入口：定义管理、crontab 部署、run-now、会话监听。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { CronSchedulerService, type ServiceConfig } from './service.ts'
import { registerAutomationRpc } from './rpc.ts'
import { registerAutomationTools } from './tools.ts'
import { SessionWatcher } from './watcher.ts'
import { AUTOMATION_PROMPT_NAME, AUTOMATION_PROMPT_ORDER, AUTOMATION_PROMPT_TEXT } from './prompt.ts'

export const name = 'dsh-cron-scheduler'
export const inject = [
  'timer', 'agents', 'sessions', 'workspaceRegistry', 'tools', 'connection',
]

export interface Config {
  readonly dshCommand?: string
  readonly profile?: string
  readonly pollSeconds?: number
  readonly historyLimit?: number
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config: ServiceConfig = {
    dshCommand: rawConfig.dshCommand,
    profile: rawConfig.profile ?? 'headless',
    pollSeconds: clampInteger(rawConfig.pollSeconds, 3, 300, 10),
    historyLimit: clampInteger(rawConfig.historyLimit, 5, 5_000, 100),
  }

  ctx.effect(async () => {
    let alive = true
    const service = new CronSchedulerService(ctx, config)
    const watcher = new SessionWatcher(ctx, service.definitions, service.runs)
    const agentTools = new Map<object, () => void | Promise<void>>()
    let cleaned = false
    let stopCreated = () => {}
    let stopDisposed = () => {}
    let stopPrompt = () => {}
    let removeRpc = async (): Promise<void> => {}
    let timerHandle: (() => void) | undefined

    const cleanup = async (): Promise<void> => {
      if (cleaned) return
      cleaned = true
      alive = false
      if (timerHandle !== undefined) {
        try { timerHandle() } catch { /* 忽略 */ }
      }
      for (const stop of [stopCreated, stopDisposed, stopPrompt]) {
        try { stop() } catch (error: unknown) {
          ctx.logger.warn(`dsh-cron-scheduler: lifecycle cleanup failed: ${String(error)}`)
        }
      }
      const results = await Promise.allSettled([
        removeRpc(),
        ...[...agentTools.values()].reverse().map(dispose => Promise.resolve().then(dispose)),
      ])
      for (const result of results) {
        if (result.status === 'rejected') {
          ctx.logger.warn(`dsh-cron-scheduler: contribution cleanup failed: ${String(result.reason)}`)
        }
      }
      agentTools.clear()
      await service.dispose()
    }

    try {
      const mountTools = (agent: any): void => {
        if (!alive || agentTools.has(agent)) return
        if (!ctx.agents.roots().includes(agent)) return
        const dispose = agent.ctx.effect(
          () => registerAutomationTools(service, agent),
          'dsh-cron-scheduler: management tools',
        )
        agentTools.set(agent, dispose)
      }
      for (const agent of ctx.agents.roots()) mountTools(agent)
      stopCreated = ctx.on('agent/created', ({ agent }: any) => { mountTools(agent) })
      stopDisposed = ctx.on('agent/disposed', ({ agent }: any) => { agentTools.delete(agent) })

      const systemPrompt = ctx.get('systemPrompt') as { section?(input: { name: string; order: number; text: string }): () => void } | undefined
      if (typeof systemPrompt?.section === 'function') {
        stopPrompt = systemPrompt.section({
          name: AUTOMATION_PROMPT_NAME,
          order: AUTOMATION_PROMPT_ORDER,
          text: AUTOMATION_PROMPT_TEXT,
        })
      }

      removeRpc = registerAutomationRpc(ctx, service)

      const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
      const settle = async (): Promise<void> => {
        if (!alive) return
        try {
          await service.start()
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-cron-scheduler: initial deploy failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!alive) return
        await watcher.sweep().catch(() => undefined)
        timerHandle = ctx.setInterval(() => {
          void watcher.sweep().catch((error: unknown) => {
            ctx.logger.warn(`dsh-cron-scheduler: watcher sweep failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }, config.pollSeconds * 1_000)
      }
      if (loader === undefined) void settle()
      else {
        void loader.await().then(settle, (error: unknown) => {
          if (alive) ctx.logger.warn(`dsh-cron-scheduler: Loader did not settle: ${String(error)}`)
        })
      }

      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  }, 'dsh-cron-scheduler: host service')
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export type * from './types.ts'
export { validateCron, nextCronRun, normalizeCron, CRON_PRESETS } from './cron.ts'
export { generateWrapperFiles, wrapperScript } from './deploy.ts'
