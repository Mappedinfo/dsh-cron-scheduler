/**
 * 开发自测：cron 校验 + wrapper 全链路（含 manifest 生命周期）。
 * 不触碰真实 crontab（只调用 generateWrapperFiles，不调 syncDeployments）。
 */
import { mkdtemp, readFile, writeFile, chmod, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateCron, nextCronRun, generateWrapperFiles } from '../lib/test-entry.js'

const execFileAsync = promisify(execFile)

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name} ${detail}`) }
}

// ---- cron 校验 ----
console.log('== validateCron ==')
check('5 字段标准', validateCron('0 9 * * 1-5').ok)
check('步长', validateCron('*/15 * * * *').ok)
check('范围', validateCron('0 9-18 * * MON-FRI').ok)
check('列表', validateCron('0,30 9 * * 1,3,5').ok)
check('月份名称', validateCron('0 9 1 JAN,JUL *').ok)
check('@daily', validateCron('@daily').ok && validateCron('@daily').normalized === '0 0 * * *')
check('@reboot', validateCron('@reboot').ok && validateCron('@reboot').normalized === '@reboot')
check('6 字段被拒', !validateCron('0 0 9 * * 1-5').ok)
check('非法分钟', !validateCron('61 * * * *').ok)
check('非法星期名', !validateCron('0 9 * * XYZ').ok)
check('非法步长', !validateCron('*/0 * * * *').ok)
check('范围反转被拒', !validateCron('0 18-9 * * *').ok)
const next = nextCronRun('0 9 * * 1-5')
check('nextCronRun', next !== null && !Number.isNaN(Date.parse(next ?? '')))

// ---- wrapper 生成 + 执行 ----
console.log('== wrapper ==')
const base = await mkdtemp(join(tmpdir(), 'dsh-cron-test-'))
const paths = {
  base,
  definitions: join(base, 'definitions'),
  wrappers: join(base, 'wrappers'),
  logs: join(base, 'logs'),
  runs: join(base, 'runs'),
  locks: join(base, 'locks'),
  tasks: join(base, 'tasks'),
}
// 假 dsh：写一行输出后按参数退出
const fakeDsh = join(base, 'fake-dsh.sh')
await writeFile(fakeDsh, '#!/bin/bash\necho "hello from fake dsh"\nexit ${FAKE_EXIT:-0}\n', { mode: 0o755 })
await chmod(fakeDsh, 0o755)

const workspace = join(base, 'workspace')
await mkdir(workspace, { recursive: true })

const definition = {
  version: 1,
  id: 'task-test1',
  revision: 1,
  name: '测试任务',
  prompt: '把 hello.txt 写成 hello world',
  cron: '0 9 * * *',
  status: 'active',
  workspaceId: 'ws1',
  cwd: workspace,
  permission: 'read-only',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deployedAt: null,
  deployError: null,
}

const results = await generateWrapperFiles([definition], {
  paths,
  dshHome: join(base, '.dsh'),
  dshCommand: fakeDsh,
  profile: 'headless',
})
const result = results.get('task-test1')
check('wrapper 生成成功', result?.error === null, JSON.stringify(result))

const wrapperPath = join(paths.wrappers, 'task-test1.sh')
const wrapperText = await readFile(wrapperPath, 'utf8')
check('wrapper 含任务 id', wrapperText.includes("AUTOMATION_ID='task-test1'"))
check('wrapper 含权限 env', wrapperText.includes('export DSH_PERMISSION_MODE=\'read-only\''))
check('wrapper 含 headless 调用', wrapperText.includes('--profile "$PROFILE" "$(cat "$TASK_FILE")"'))
check('task 文件含标记', (await readFile(join(paths.tasks, 'task-test1.txt'), 'utf8')).includes('[dsh-cron:task=task-test1]'))

// 执行 wrapper（成功路径）
const runOut = await execFileAsync('/bin/bash', [wrapperPath, 'manual'], { encoding: 'utf8' })
check('run-now 输出 runId', /^task-test1-\d{8}-\d{6}-\d+$/.test(runOut.stdout.trim()), runOut.stdout)
const runId = runOut.stdout.trim()
const manifestPath = join(paths.runs, `${runId}.json`)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
check('manifest trigger=manual', manifest.trigger === 'manual', JSON.stringify(manifest))
check('manifest status=succeeded', manifest.status === 'succeeded', manifest.status)
check('manifest 有 startedAt/finishedAt', manifest.startedAt !== null && manifest.finishedAt !== null)
check('dsh 输出进了日志', (await readFile(join(paths.logs, 'task-test1.log'), 'utf8')).includes('hello from fake dsh'))

// 失败路径
await writeFile(join(base, 'exit1.sh'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
await chmod(join(base, 'exit1.sh'), 0o755)
const def2 = { ...definition, id: 'task-fail', cron: '@daily', status: 'paused' }
await generateWrapperFiles([def2], { paths, dshHome: join(base, '.dsh'), dshCommand: fakeDsh, profile: 'headless' })
check('paused 规则不生成 wrapper', await readFile(join(paths.wrappers, 'task-fail.sh'), 'utf8').then(() => false).catch(() => true))

// 重叠锁：第一个 wrapper 挂住时第二个应 skipped
await writeFile(fakeDsh, '#!/bin/bash\nsleep 5\nexit 0\n', { mode: 0o755 })
await chmod(fakeDsh, 0o755)
const def3 = { ...definition, id: 'task-lock' }
await generateWrapperFiles([def3], { paths, dshHome: join(base, '.dsh'), dshCommand: fakeDsh, profile: 'headless' })
const lockWrapper = join(paths.wrappers, 'task-lock.sh')
const first = execFileAsync('/bin/bash', [lockWrapper, 'schedule'], { encoding: 'utf8' })
// 等第一个 run 进入 running（锁已持有）再启动第二个，避免时序竞态
let firstRun = ''
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100))
  const entries = await readdir(join(paths.runs))
  const running = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const run = JSON.parse(await readFile(join(paths.runs, entry), 'utf8'))
    if (run.automationId === 'task-lock' && run.status === 'running') running.push(run.id)
  }
  if (running.length > 0) { firstRun = running[0]; break }
}
check('第一个 run 进入 running', firstRun !== '', firstRun)
const second = await execFileAsync('/bin/bash', [lockWrapper, 'schedule'], { encoding: 'utf8' })
const secondRun = second.stdout.trim()
await new Promise(resolve => setTimeout(resolve, 5500))
check('重叠运行有 runId 输出', /^task-lock-\d{8}-\d{6}-\d+$/.test(secondRun), secondRun)
const secondManifest = JSON.parse(await readFile(join(paths.runs, `${secondRun}.json`), 'utf8'))
check('重叠运行被跳过', secondManifest.status === 'skipped', secondManifest.status)
const firstManifest = JSON.parse(await readFile(join(paths.runs, `${firstRun}.json`), 'utf8'))
check('首运行完成', firstManifest.status === 'succeeded', firstManifest.status)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
