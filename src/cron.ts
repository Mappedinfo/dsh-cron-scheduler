/**
 * Cron 表达式校验/归一化与下次运行时间估算。
 * 支持 5 字段（分 时 日 月 周）+ @-快捷方式。
 * 系统 crontab 本身是最终执行者；这里只做输入校验与展示用估算。
 */

import { CronExpressionParser } from 'cron-parser'
import type { CronValidation } from './types.ts'

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

/** @-快捷方式 → 标准 5 字段表达式。 */
const MACROS: Readonly<Record<string, string>> = {
  '@reboot': '@reboot',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MACRO_ORDER: readonly string[] = [
  '@reboot', '@yearly', '@annually', '@monthly', '@weekly',
  '@daily', '@midnight', '@hourly',
]

export const CRON_PRESETS: readonly { readonly key: string; readonly cron: string; readonly labelZh: string; readonly labelEn: string }[] = [
  { key: 'hourly', cron: '0 * * * *', labelZh: '每小时整点', labelEn: 'Every hour' },
  { key: 'daily-9', cron: '0 9 * * *', labelZh: '每天 09:00', labelEn: 'Daily 09:00' },
  { key: 'daily-22', cron: '0 22 * * *', labelZh: '每天 22:00', labelEn: 'Daily 22:00' },
  { key: 'weekday-9', cron: '0 9 * * 1-5', labelZh: '工作日 09:00', labelEn: 'Weekdays 09:00' },
  { key: 'weekly-mon-9', cron: '0 9 * * 1', labelZh: '每周一 09:00', labelEn: 'Mondays 09:00' },
  { key: 'monthly-1-9', cron: '0 9 1 * *', labelZh: '每月 1 日 09:00', labelEn: 'Monthly 1st 09:00' },
  { key: 'reboot', cron: '@reboot', labelZh: '登录/开机时', labelEn: 'At login/reboot' },
]

/** 规范化：trim、折叠空白、@-宏展开（@reboot 保持原样）。 */
export function normalizeCron(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, ' ')
  const macro = MACROS[trimmed.toLowerCase()]
  return macro ?? trimmed
}

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value)
}

/**
 * 解析单个 token（*、数字、名称、a-b 范围，可含名称）。
 * @returns 规范化后的 token；数字范围校验通过后才接受。
 */
function resolveToken(
  token: string,
  names: Readonly<Record<string, number>> | undefined,
  min: number,
  max: number,
  field: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  if (token === '*') return { ok: true, value: '*' }
  if (token.includes('-')) {
    const [left, right] = token.split('-', 2)
    if (left === undefined || right === undefined) return { ok: false, error: `${field} 范围格式错误` }
    const leftResolved = resolveAtom(left, names, min, max, field)
    if (!leftResolved.ok) return leftResolved
    const rightResolved = resolveAtom(right, names, min, max, field)
    if (!rightResolved.ok) return rightResolved
    const ln = Number(leftResolved.value)
    const rn = Number(rightResolved.value)
    if (ln > rn) return { ok: false, error: `${field} 范围起点不能大于终点` }
    return { ok: true, value: `${String(ln)}-${String(rn)}` }
  }
  return resolveAtom(token, names, min, max, field)
}

function resolveAtom(
  value: string,
  names: Readonly<Record<string, number>> | undefined,
  min: number,
  max: number,
  field: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  if (isNumeric(value)) {
    const n = Number(value)
    if (n < min || n > max) return { ok: false, error: `${field} 超出范围 ${min}-${max}` }
    return { ok: true, value: String(n) }
  }
  if (names === undefined) return { ok: false, error: `${field} 不是有效数字: ${value}` }
  const mapped = names[value.toUpperCase()]
  if (mapped === undefined) return { ok: false, error: `${field} 出现无法识别的名称 ${value}` }
  if (mapped < min || mapped > max) return { ok: false, error: `${field} 超出范围 ${min}-${max}` }
  return { ok: true, value: String(mapped) }
}

/** 校验一个字段：支持星号、范围、步长、逗号列表（可含名称）。 */
function validateField(
  raw: string,
  field: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> | undefined,
): string | undefined {
  if (raw === '') return `${field} 为空`
  const list = raw.split(',')
  const normalizedParts: string[] = []
  for (const part of list) {
    const piece = part.trim()
    if (piece === '') return `${field} 含空项`
    const stepMatch = /^(.*)\/(\d+)$/.exec(piece)
    const step = stepMatch === null || stepMatch === undefined ? undefined : Number(stepMatch[2])
    if (step !== undefined && step < 1) return `${field} 步长必须 >= 1`
    const baseToken = stepMatch === null || stepMatch === undefined ? piece : (stepMatch[1] ?? piece)
    const resolved = resolveToken(baseToken, names, min, max, field)
    if (!resolved.ok) return resolved.error
    normalizedParts.push(step === undefined ? resolved.value : `${resolved.value}/${String(step)}`)
  }
  return undefined
}

/**
 * 校验并规范化一条 cron 表达式。
 * @returns ok:false + 中文错误信息，或 ok:true + 可写进 crontab 的规范化表达式。
 */
export function validateCron(input: string): CronValidation {
  const normalized = normalizeCron(input)
  if (normalized === '@reboot') return { ok: true, normalized }
  const fields = normalized.split(' ')
  if (fields.length !== 5) {
    return { ok: false, error: `需要 5 个字段（分 时 日 月 周），实际 ${fields.length} 个：${normalized}` }
  }
  const [minute, hour, day, month, weekday] = fields
  const checks: readonly [string, string, number, number, Readonly<Record<string, number>> | undefined][] = [
    [minute ?? '', '分钟', 0, 59, undefined],
    [hour ?? '', '小时', 0, 23, undefined],
    [day ?? '', '日期', 1, 31, undefined],
    [month ?? '', '月份', 1, 12, MONTHS],
    [weekday ?? '', '星期', 0, 7, WEEKDAYS],
  ]
  const parts: string[] = []
  for (const [value, label, lo, hi, names] of checks) {
    const error = validateField(value, label, lo, hi, names)
    if (error !== undefined) return { ok: false, error }
    parts.push(value)
  }
  return { ok: true, normalized: parts.join(' ') }
}

/** 估算下一次运行时间（仅展示用；实际由系统 cron 决定）。 */
export function nextCronRun(expression: string, from: Date = new Date()): string | null {
  const normalized = normalizeCron(expression)
  if (normalized === '@reboot') return null
  try {
    const cron = CronExpressionParser.parse(normalized, { currentDate: from })
    const next = cron.next()
    return next.toDate().toISOString()
  } catch {
    return null
  }
}

export { MACRO_ORDER, MACROS }
