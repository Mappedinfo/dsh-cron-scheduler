/** 设置页：规则 CRUD + 运行历史 + 部署状态。 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { validateCron, CRON_PRESETS } from '../cron.ts'
import type { CreateInput, DefinitionView, RunView, Translate } from './contracts.js'
import type { CronRuntime, CronStateSource } from './runtime.js'

function useCronState(source: CronStateSource): ReturnType<CronStateSource['getSnapshot']> {
  const [state, setState] = useState(source.getSnapshot())
  useEffect(() => source.subscribe(() => setState(source.getSnapshot())), [source])
  return state
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const STATUS_COLORS: Record<string, string> = {
  succeeded: '#16a34a',
  failed: '#dc2626',
  running: '#2563eb',
  queued: '#ca8a04',
  skipped: '#6b7280',
  active: '#16a34a',
  paused: '#6b7280',
}

const style: Record<string, React.CSSProperties> = {
  root: { padding: '16px 20px', fontFamily: 'inherit' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
  title: { fontSize: 16, fontWeight: 600, margin: 0 },
  button: {
    padding: '6px 12px', borderRadius: 6, border: '1px solid #d0d7de', background: '#f6f8fa',
    cursor: 'pointer', fontSize: 13,
  },
  primary: {
    padding: '6px 14px', borderRadius: 6, border: '1px solid transparent', background: '#2563eb',
    color: '#fff', cursor: 'pointer', fontSize: 13,
  },
  danger: { padding: '6px 12px', borderRadius: 6, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 13 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #d0d7de', fontWeight: 600, whiteSpace: 'nowrap' },
  td: { padding: '6px 8px', borderBottom: '1px solid #eaeef2', verticalAlign: 'top' },
  badge: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, color: '#fff' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  muted: { color: '#6b7280', fontSize: 12 },
  modal: {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modalCard: { background: '#fff', borderRadius: 10, padding: '20px 24px', width: 560, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' },
  field: { marginBottom: 12 },
  label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 },
  input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13, fontFamily: 'inherit' },
  textarea: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13, minHeight: 90, fontFamily: 'inherit', resize: 'vertical' },
  select: { padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de', fontSize: 13 },
  hint: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  error: { fontSize: 12, color: '#dc2626', marginTop: 4 },
  actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' },
  notice: { fontSize: 12, color: '#b45309', marginTop: 8 },
  empty: { color: '#6b7280', fontSize: 13, padding: '12px 0' },
  footer: { marginTop: 20, borderTop: '1px solid #eaeef2', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
}

export function SettingsView(props: {
  readonly t: Translate
  readonly runtime: CronRuntime
  readonly closeSettings?: () => void
  readonly openSession?: (sessionId: string) => void
}): ReactNode {
  const { t, runtime } = props
  const state = useCronState(runtime.source)
  const [editing, setEditing] = useState<null | { readonly mode: 'create' } | { readonly mode: 'edit'; readonly def: DefinitionView }>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (state.phase === 'idle') void runtime.refresh().catch(() => undefined)
    const interval = window.setInterval(() => { void runtime.refresh().catch(() => undefined) }, 15_000)
    return () => window.clearInterval(interval)
  }, [state.phase, runtime])

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (state.phase === 'error') {
    return (
      <div style={style.root}>
        <p style={style.error}>{t('error')}：{state.error}</p>
        <button style={style.button} onClick={() => { void runtime.refresh().catch(() => undefined) }}>{t('retry')}</button>
      </div>
    )
  }

  const snapshot = state.snapshot
  const definitions = snapshot?.definitions ?? []
  const runs = snapshot?.runs ?? []
  const workspaceByPath = new Map((snapshot?.workspaces ?? []).map(workspace => [workspace.path, workspace]))
  const dshSourceLabel = snapshot === undefined ? '' : {
    config: t('dsh.source.config'),
    env: t('dsh.source.env'),
    path: t('dsh.source.path'),
    'auto-shim': t('dsh.source.auto-shim'),
    fallback: t('dsh.source.fallback'),
  }[snapshot.dsh.source] ?? ''

  return (
    <div style={style.root}>
      <div style={style.header}>
        <h2 style={style.title}>{t('tab')}</h2>
        <button style={style.primary} disabled={busy} onClick={() => setEditing({ mode: 'create' })}>{t('create')}</button>
      </div>
      {state.phase === 'loading' && snapshot === undefined && <div style={style.muted}>{t('loading')}</div>}
      {notice !== null && <div style={style.notice}>{notice}</div>}
      {snapshot !== undefined && (
        <>
          <div style={style.muted}>{t('dsh.cmd')}：<span style={style.mono}>{snapshot.dsh.command}</span>{dshSourceLabel === '' ? '' : `（${dshSourceLabel}）`}</div>
          {definitions.length === 0 ? (
            <div style={style.empty}>{t('empty')}</div>
          ) : (
            <table style={style.table}>
              <thead>
                <tr>
                  <th style={style.th}>{t('name')}</th>
                  <th style={style.th}>{t('cron')}</th>
                  <th style={style.th}>{t('workspace')}</th>
                  <th style={style.th}>{t('permission')}</th>
                  <th style={style.th}>{t('status')}</th>
                  <th style={style.th}>{t('nextRun')}</th>
                  <th style={style.th}>{t('lastRun')}</th>
                  <th style={style.th}>{t('deploy')}</th>
                  <th style={style.th}>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {definitions.map(definition => (
                  <tr key={definition.id}>
                    <td style={style.td}><strong>{definition.name}</strong></td>
                    <td style={style.td}><span style={style.mono}>{definition.cron}</span></td>
                    <td style={style.td}>
                      <div>{workspaceByPath.get(definition.cwd)?.title ?? definition.cwd}</div>
                      <div style={style.muted}>{definition.cwd}</div>
                    </td>
                    <td style={style.td}>{definition.permission === 'read-only' ? t('permission.read-only') : t('permission.workspace-write')}</td>
                    <td style={style.td}>
                      <span style={{ ...style.badge, background: STATUS_COLORS[definition.status] ?? '#6b7280' }}>
                        {definition.status === 'active' ? t('status.active') : t('status.paused')}
                      </span>
                    </td>
                    <td style={style.td}>{formatTime(definition.nextRunAt)}</td>
                    <td style={style.td}>
                      {definition.lastRunAt === null
                        ? '—'
                        : <span>
                            {formatTime(definition.lastRunAt)}
                            {definition.lastRunStatus !== null && (
                              <span style={{ color: STATUS_COLORS[definition.lastRunStatus] ?? '#6b7280' }}> · {t(`run.status.${definition.lastRunStatus}`)}</span>
                            )}
                          </span>}
                    </td>
                    <td style={style.td}>
                      {definition.deployError === null && definition.deployedAt !== null && <span style={{ color: '#16a34a' }}>{t('deploy.ok')}</span>}
                      {definition.deployError !== null && <span title={definition.deployError} style={{ color: '#dc2626' }}>{t('deploy.fail')}</span>}
                      {definition.deployedAt === null && definition.deployError === null && <span style={style.muted}>—</span>}
                    </td>
                    <td style={style.td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button style={style.button} disabled={busy} onClick={() => setEditing({ mode: 'edit', def: definition })}>{t('edit')}</button>
                        <button style={style.button} disabled={busy} onClick={() => {
                          void runAction(() => runtime.mutateAutomation(definition.id, definition.status === 'active' ? 'pause' : 'resume'))
                        }}>{definition.status === 'active' ? t('pause') : t('resume')}</button>
                        <button style={style.button} disabled={busy} onClick={() => { void runAction(() => runtime.runNow(definition.id)) }}>{t('runNow')}</button>
                        <button style={style.danger} disabled={busy} onClick={() => {
                          if (window.confirm(t('delete.confirm'))) void runAction(() => runtime.mutateAutomation(definition.id, 'delete'))
                        }}>{t('delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={style.sectionTitle}>{t('runs')}</h3>
          {runs.length === 0 ? (
            <div style={style.empty}>{t('runs.empty')}</div>
          ) : (
            <table style={style.table}>
              <thead>
                <tr>
                  <th style={style.th}>{t('run.time')}</th>
                  <th style={style.th}>{t('run.task')}</th>
                  <th style={style.th}>{t('run.trigger')}</th>
                  <th style={style.th}>{t('run.status')}</th>
                  <th style={style.th}>{t('run.session')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 100).map(run => (
                  <tr key={run.id}>
                    <td style={style.td}>{formatTime(run.scheduledFor)}</td>
                    <td style={style.td}>{run.automationId}</td>
                    <td style={style.td}>{run.trigger === 'schedule' ? t('run.trigger.schedule') : t('run.trigger.manual')}</td>
                    <td style={style.td}>
                      <span style={{ ...style.badge, background: STATUS_COLORS[run.status] ?? '#6b7280' }}>{t(`run.status.${run.status}`)}</span>
                      {run.error !== null && <div style={style.muted} title={run.error}>{run.error}</div>}
                    </td>
                    <td style={style.td}>
                      {run.sessionId !== null && props.openSession !== undefined
                        ? <button style={style.button} onClick={() => props.openSession?.(run.sessionId as string)}>{t('open')}</button>
                        : run.sessionId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={style.footer}>
            <span style={style.muted}>{definitions.length} tasks · {runs.length} runs</span>
            {props.closeSettings !== undefined && <button style={style.button} onClick={props.closeSettings}>{t('close')}</button>}
          </div>
        </>
      )}

      {editing !== null && (
        <EditorModal
          t={t}
          mode={editing.mode}
          definition={editing.mode === 'edit' ? editing.def : undefined}
          workspaces={snapshot?.workspaces ?? []}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await runAction(async () => {
              if (editing.mode === 'create') await runtime.createAutomation(input)
              else await runtime.updateAutomation(editing.def.id, input)
            })
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function EditorModal(props: {
  readonly t: Translate
  readonly mode: 'create' | 'edit'
  readonly definition: DefinitionView | undefined
  readonly workspaces: readonly { readonly id: string; readonly title: string; readonly path: string }[]
  readonly onCancel: () => void
  readonly onSave: (input: CreateInput) => Promise<void>
}): ReactNode {
  const { t, definition } = props
  const [name, setName] = useState(definition?.name ?? '')
  const [cron, setCron] = useState(definition?.cron ?? '0 9 * * *')
  const [preset, setPreset] = useState<string>(definition?.cron ?? 'daily-9')
  const [prompt, setPrompt] = useState(definition?.prompt ?? '')
  const [cwd, setCwd] = useState(definition?.cwd ?? props.workspaces[0]?.path ?? '')
  const [permission, setPermission] = useState<'read-only' | 'workspace-write'>(definition?.permission ?? 'read-only')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const cronValidation = useMemo(() => validateCron(cron), [cron])

  const applyPreset = (key: string): void => {
    setPreset(key)
    if (key === 'custom') return
    const found = CRON_PRESETS.find(item => item.key === key)
    if (found !== undefined) setCron(found.cron)
  }

  const submit = async (): Promise<void> => {
    if (name.trim() === '') { setError(t('name') + ' 不能为空'); return }
    if (prompt.trim() === '') { setError(t('prompt') + ' 不能为空'); return }
    if (!cronValidation.ok) { setError(`${t('invalid.cron')}${cronValidation.error}`); return }
    if (cwd.trim() === '') { setError(t('workspace') + ' 不能为空'); return }
    setSaving(true)
    try {
      await props.onSave({ name: name.trim(), prompt: prompt.trim(), cron: cronValidation.normalized, cwd: cwd.trim(), permission })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={style.modal}>
      <div style={style.modalCard}>
        <h3 style={style.title}>{props.mode === 'create' ? t('create.title') : t('edit.title')}</h3>
        <div style={style.field}>
          <label style={style.label}>{t('name')}</label>
          <input style={style.input} value={name} onChange={event => setName(event.target.value)} />
        </div>
        <div style={style.field}>
          <label style={style.label}>{t('cron.preset')}</label>
          <select style={style.select} value={preset} onChange={event => applyPreset(event.target.value)}>
            {CRON_PRESETS.map(item => (
              <option key={item.key} value={item.key}>{t(`preset.${item.key}`)}</option>
            ))}
            <option value="custom">{t('preset.custom')}</option>
          </select>
        </div>
        <div style={style.field}>
          <label style={style.label}>{t('cron')}</label>
          <input style={style.input} placeholder={t('cron.placeholder')} value={cron} onChange={event => { setCron(event.target.value); setPreset('custom') }} />
          <div style={cronValidation.ok ? style.hint : style.error}>
            {cronValidation.ok ? t('cron.hint') : `${t('invalid.cron')}${cronValidation.error}`}
          </div>
        </div>
        <div style={style.field}>
          <label style={style.label}>{t('prompt')}</label>
          <textarea style={style.textarea} placeholder={t('prompt.placeholder')} value={prompt} onChange={event => setPrompt(event.target.value)} />
        </div>
        <div style={style.field}>
          <label style={style.label}>{t('workspace')}</label>
          {props.workspaces.length === 0 ? (
            <div style={style.hint}>{t('noWorkspace')}</div>
          ) : (
            <select style={style.select} value={cwd} onChange={event => setCwd(event.target.value)}>
              {props.workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.path}>{workspace.title} — {workspace.path}</option>
              ))}
            </select>
          )}
        </div>
        <div style={style.field}>
          <label style={style.label}>{t('permission')}</label>
          <select style={style.select} value={permission} onChange={event => setPermission(event.target.value as 'read-only' | 'workspace-write')}>
            <option value="read-only">{t('permission.read-only')}</option>
            <option value="workspace-write">{t('permission.workspace-write')}</option>
          </select>
        </div>
        {error !== null && <div style={style.error}>{error}</div>}
        <div style={style.actions}>
          <button style={style.button} onClick={props.onCancel}>{t('cancel')}</button>
          <button style={style.primary} disabled={saving} onClick={() => { void submit() }}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}
