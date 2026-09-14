/**
 * 开发自测：cron 校验 + wrapper 全链路（含 manifest 生命周期）。
 * 不触碰真实 crontab（只调用 generateWrapperFiles，不调 syncDeployments）。
 */
import { existsSync } from 'node:fs'
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

// ---- service.create：真实 workspaceRegistry 签名回归（create 接收字符串 path） ----
console.log('== service.create ==')
const { CronSchedulerService } = await import('../lib/test-entry.js')
const fakeHome = join(base, 'fake-dsh-home')
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = fakeHome
const svcCtx = {
  workspaceRegistry: {
    resolveByPath: async () => undefined,
    create: async (pathArg) => ({ id: 'ws-real', title: 'Coding', path: pathArg }),
  },
}
const svc = new CronSchedulerService(svcCtx, { dshCommand: fakeDsh, profile: 'headless', pollSeconds: 10, historyLimit: 50 })
let createdId = ''
try {
  const def = await svc.create({ name: '回归测试', prompt: '只回复 OK', cron: '0 9 * * *', cwd: workspace, permission: 'read-only' })
  createdId = def.id
  check('service.create 成功（字符串 path 签名）', createdId.startsWith('task-'), createdId)
  const list = await svc.definitions.list()
  check('定义已落盘', list.some(d => d.id === createdId))
  const wrapperText2 = await readFile(join(svc.paths.wrappers, `${createdId}.sh`), 'utf8')
  check('wrapper 已生成且含 dsh 命令', wrapperText2.includes(`DSH='${fakeDsh}'`), wrapperText2.split('\n').find(l => l.startsWith('DSH=')))
} catch (error) {
  check('service.create 无异常', false, String(error))
} finally {
  if (createdId !== '') await svc.delete(createdId).catch(() => undefined)
  await svc.dispose()
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
}
check('crontab 已还原为空', (await new Promise(resolve => {
  execFile('crontab', ['-l'], (err, stdout) => resolve(err === null && stdout.trim() === ''))
})))



// ---- spawnWrapper：只等 runId 返回，不杀长任务 ----
console.log('== spawnWrapper ==')
const { spawnWrapper } = await import('../lib/test-entry.js')
await writeFile(fakeDsh, '#!/bin/bash\nsleep 3\nexit 0\n', { mode: 0o755 })
await chmod(fakeDsh, 0o755)
const defSw = { ...definition, id: 'task-sw' }
await generateWrapperFiles([defSw], { paths, dshHome: join(base, '.dsh'), dshCommand: fakeDsh, profile: 'headless' })
const swStart = Date.now()
const swResult = await spawnWrapper(paths, 'task-sw', 'manual')
const swElapsed = Date.now() - swStart
check('spawnWrapper 快速返回 runId（<2s）', swResult.runId !== null && /^task-sw-\d{8}-\d{6}-\d+$/.test(swResult.runId ?? '') && swElapsed < 2000, JSON.stringify(swResult) + ` ${swElapsed}ms`)
const swManifest1 = JSON.parse(await readFile(join(paths.runs, `${swResult.runId}.json`), 'utf8'))
check('返回时子进程仍在运行', swManifest1.status === 'running' || swManifest1.status === 'queued', swManifest1.status)
await new Promise(r => setTimeout(r, 3500))
const swManifest2 = JSON.parse(await readFile(join(paths.runs, `${swResult.runId}.json`), 'utf8'))
check('子进程完成后终态写入', swManifest2.status === 'succeeded', swManifest2.status)


// ---- dsh 命令自动解析 ----// ---- dsh 命令自动解析 ----
console.log('== dsh resolve ==')
const { deriveCliEntryFromArgv, ensureDshShim, resolveDshCommand } = await import('../lib/test-entry.js')
const checkout = '/Users/shiqi/Coding/github/deepseek-ai/deepseek-harness'
const entryFromSrc = deriveCliEntryFromArgv(['node', 'apps/cli/src/bin.ts', 'web'], checkout)
check('dev 模式 argv 推导 lib/bin.js', entryFromSrc === `${checkout}/apps/cli/lib/bin.js`, entryFromSrc)
const entryFromLib = deriveCliEntryFromArgv(['node', `${checkout}/apps/cli/lib/bin.js`], '/')
check('lib/bin.js 直接命中', entryFromLib === `${checkout}/apps/cli/lib/bin.js`, entryFromLib)
check('无关 argv 返回 undefined', deriveCliEntryFromArgv(['node', 'server.js'], '/') === undefined)

const shimBase = join(base, 'shim-home')
const shimPaths = { base: shimBase, definitions: 'd', wrappers: 'w', logs: 'l', runs: 'r', locks: 'k', tasks: 't' }
const shimPath = ensureDshShim(shimPaths, '/opt/homebrew/bin/node', entryFromSrc)
const shimText = await readFile(shimPath, 'utf8')
check('shim 内容正确', shimText.includes("exec '/opt/homebrew/bin/node'") && shimText.includes(entryFromSrc), shimText.trim())

// 模拟：PATH 无 dsh、argv 指向 dev 入口 → 自动 shim
const savedArgv = process.argv
const savedPath = process.env.PATH
const savedBin = process.env.DSH_BIN
process.argv = ['node', `${checkout}/apps/cli/src/bin.ts`, 'web']
process.env.PATH = '/nonexistent'
delete process.env.DSH_BIN
const auto = resolveDshCommand(undefined, shimPaths)
check('argv 推导自动 shim', auto.source === 'auto-shim', JSON.stringify(auto))
check('auto-shim 指向 shim 文件', auto.command === shimPath, auto.command)
// 显式配置优先
const cfg = resolveDshCommand('/custom/dsh', shimPaths)
check('config 优先', cfg.source === 'config' && cfg.command === '/custom/dsh', JSON.stringify(cfg))
process.argv = savedArgv
process.env.PATH = savedPath
if (savedBin === undefined) delete process.env.DSH_BIN
else process.env.DSH_BIN = savedBin


// ---- 依赖声明完整性：host bundle 的每个 @deepseek-ai 值导入都必须声明为 peer ----
console.log('== peer 声明完整性 ==')
{
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const declared = new Set(Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).peerDependencies ?? {}))
  const imported = new Set()
  for (const m of bundle.matchAll(/from\s+"(@deepseek-ai\/[^"]+)"/g)) imported.add(m[1])
  console.log('  bundle 导入:', [...imported].join(', ') || '(无)')
  const missing = [...imported].filter(name => !declared.has(name))
  check('host bundle 的 @deepseek-ai 导入均已声明为 peer', missing.length === 0, missing.join(', '))
  const missingFiles = [...declared].filter(name => {
    if (name === '@deepseek-ai/cordis') return false
    return !existsSync(new URL(`../node_modules/${name}/package.json`, import.meta.url))
  })
  check('已声明的 peer 均已安装（link 安装下可解析）', missingFiles.length === 0, missingFiles.join(', '))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
