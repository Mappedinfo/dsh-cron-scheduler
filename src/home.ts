/** DSH home 与插件数据目录解析（与 base bundle 的 dshHomePath 语义一致）。 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析 DSH home：`$DSH_HOME` 优先，缺省 `~/.dsh`。 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** 插件数据根：`<dshHome>/cron-scheduler`。 */
export function pluginBaseDir(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'cron-scheduler')
}

export interface PluginPaths {
  readonly base: string
  readonly definitions: string
  readonly wrappers: string
  readonly logs: string
  readonly runs: string
  readonly locks: string
  readonly tasks: string
}

export function pluginPaths(base: string = pluginBaseDir()): PluginPaths {
  return {
    base,
    definitions: join(base, 'definitions'),
    wrappers: join(base, 'wrappers'),
    logs: join(base, 'logs'),
    runs: join(base, 'runs'),
    locks: join(base, 'locks'),
    tasks: join(base, 'tasks'),
  }
}
