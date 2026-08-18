/**
 * dsh 命令自动解析：让 wrapper 在任意安装方式下都能找到可执行的 dsh。
 *
 * 解析链（部署时在 dsh web 进程内执行）：
 *  1. config.dshCommand            —— 显式覆盖（兜底）
 *  2. $DSH_BIN                     —— 环境变量
 *  3. `command -v dsh`             —— PATH 全局安装
 *  4. 从当前进程推导（argv[1]）：lib/bin.js / src/bin.ts → 自动生成 shim
 *  5. 失败 → 'dsh' 兜底 + 告警
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { PluginPaths } from './home.ts'

export type DshSource = 'config' | 'env' | 'path' | 'auto-shim' | 'fallback'

export interface DshResolution {
  /** wrapper 实际使用的单条可执行命令（绝对路径）。 */
  readonly command: string
  readonly source: DshSource
  /** 解析说明，用于设置页展示与告警。 */
  readonly note: string
}

/** 从 PATH 探测 dsh（同步，单次调用）。 */
function whichDsh(): string | undefined {
  try {
    const stdout = execFileSync('sh', ['-lc', 'command -v dsh'], { encoding: 'utf8' })
    const found = stdout.trim().split('\n')[0] ?? ''
    return found === '' ? undefined : found
  } catch {
    return undefined
  }
}

/** 从当前进程 argv 推导 dsh CLI 入口（绝对路径，优先已构建的 lib/bin.js）。 */
export function deriveCliEntryFromArgv(argv: readonly string[], cwd: string): string | undefined {
  const arg1 = argv[1]
  if (typeof arg1 !== 'string' || arg1 === '') return undefined
  const abs = isAbsolute(arg1) ? arg1 : resolve(cwd, arg1)
  if (abs.endsWith('src/bin.ts') || abs.endsWith('src/bin.js')) {
    // dev 模式：同目录上级 lib/bin.js（已构建、带 shebang、可执行）
    const lib = join(dirname(abs), '..', 'lib', 'bin.js')
    if (existsSync(lib)) return lib
  }
  if (abs.endsWith('.js') && existsSync(abs)) {
    return abs
  }
  return undefined
}

/** 生成/更新 shim（`exec <node> <entry> "$@"`），返回 shim 路径。 */
export function ensureDshShim(paths: PluginPaths, nodePath: string, entryPath: string): string {
  const binDir = join(paths.base, 'bin')
  const shim = join(binDir, 'dsh')
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
  const content = `#!/bin/bash\nexec ${shellEscape(nodePath)} ${shellEscape(entryPath)} "$@"\n`
  let existing: string | undefined
  try {
    existing = readFileSync(shim, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing !== content) {
    writeFileSync(shim, content, { mode: 0o755 })
    chmodSync(shim, 0o755)
  }
  return shim
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 解析 dsh 命令；需要 node+脚本 时自动生成 shim。
 * @param configCommand 插件配置里的显式命令。
 * @param paths 插件数据路径（shim 位置）。
 */
export function resolveDshCommand(
  configCommand: string | undefined,
  paths: PluginPaths,
): DshResolution {
  if (typeof configCommand === 'string' && configCommand.trim() !== '') {
    return { command: configCommand.trim(), source: 'config', note: '配置文件显式指定' }
  }
  const envBin = process.env.DSH_BIN
  if (typeof envBin === 'string' && envBin.trim() !== '') {
    return { command: envBin.trim(), source: 'env', note: '环境变量 DSH_BIN' }
  }
  const fromPath = whichDsh()
  if (fromPath !== undefined) {
    return { command: fromPath, source: 'path', note: 'PATH 自动探测' }
  }
  const nodePath = process.execPath
  const entry = deriveCliEntryFromArgv(process.argv, process.cwd())
  if (entry !== undefined) {
    try {
      const shim = ensureDshShim(paths, nodePath, entry)
      return { command: shim, source: 'auto-shim', note: `自动生成 shim → ${entry}` }
    } catch {
      // 继续降级
    }
  }
  return { command: 'dsh', source: 'fallback', note: '未探测到 dsh，请配置 dshCommand 或确保 dsh 在 PATH' }
}
