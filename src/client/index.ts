/** 客户端插件入口：注册设置页（settings.section slot）。 */

import { createElement } from 'react'
import type { ClientContext } from './contracts.js'
import { NS, zh, en } from './locales.js'
import { createCronRuntime } from './runtime.js'
import { SettingsView } from './SettingsView.js'

export const name = 'dsh-cron-scheduler-client'
export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cron-scheduler: locale')
  const t = ctx.locale.bind(NS)
  const runtime = createCronRuntime(ctx.connection.rpc)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'scheduled-tasks',
    order: 28,
    locale: NS,
    label: () => t('tab'),
    icon: 'schedule',
  }, function ScheduledTasksSettings(props: { close?: () => void }) {
    return createElement(SettingsView, {
      t,
      runtime,
      ...(props.close === undefined ? {} : { closeSettings: props.close }),
      openSession: (sessionId: string) => { void ctx.sessions?.open?.(sessionId) },
    })
  }))
}
