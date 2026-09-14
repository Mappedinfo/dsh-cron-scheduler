/**
 * Web 客户端 RPC：在 webServer 上自注册 HTTP 路由并实现官方 RPC 信封。
 *
 * 为什么不用 `ctx.connection.rpc.handle()`：DSH 0.1.5 起该方法内部通过
 * `owner.webServer` 注册路由，而 owner 是 connection 服务自身的 ctx（其 inject 只有
 * 'credentials'，不含 webServer），因此任何插件调用它都会抛
 * `cannot get property "webServer" without inject`。
 * 这里改为自己注入 webServer 并注册 prefix 路由，信封格式与官方逐字段对齐
 * （见 packages/client/connection/src/rpc-host.ts 的 rpcFetchHandler）。
 */

import type { CronSchedulerService } from './service.ts'
import type { PermissionPreset } from './types.ts'

/** RPC 通道名（客户端调用 ctx.connection.rpc.call(CHANNEL, endpoint, payload)）。 */
export const RPC_CHANNEL = '/dsh-cron-scheduler'

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const INVALID_REQUEST_RPC_ID = 'invalid-request'
/** 请求体上限，防止异常大包占用内存。 */
const MAX_BODY_BYTES = 512 * 1024

interface NodeRequest {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: any[]) => void): unknown
}
interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(chunk?: string): unknown
}

interface RpcContext {
  readonly connection?: { requestRejection?(request: unknown): number | undefined }
  readonly webServer: { register(route: unknown): () => void }
  effect(factory: () => unknown, label?: string): unknown
}

type RpcResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Record<string, unknown> }

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function errorResult(error: unknown): RpcResult {
  const message = error instanceof Error ? error.message : String(error)
  const badRequest = /不能为空|必须是|超出范围|需要 5 个字段|未注册|不存在|无法确定|至少需要|已取消|步长|范围|无法识别|表达式/.test(message)
  return {
    ok: false,
    error: {
      code: badRequest ? 'bad-request' : 'internal',
      message,
      details: badRequest ? { issues: [] } : {},
    },
  }
}

function permissionOf(value: unknown): PermissionPreset {
  if (value !== 'read-only' && value !== 'workspace-write') throw new Error('permission 必须是 read-only 或 workspace-write')
  return value
}

/** 端点分发：返回官方 RPC result 信封。 */
async function dispatch(service: CronSchedulerService, endpoint: string, payload: Record<string, unknown>): Promise<RpcResult> {
  try {
    switch (endpoint) {
      case 'snapshot':
        return { ok: true, value: await service.snapshot() }
      case 'create': {
        const input = record(payload.input, 'input')
        const created = await service.create({
          name: string(input.name, 'name'),
          prompt: string(input.prompt, 'prompt'),
          cron: string(input.cron, 'cron'),
          cwd: string(input.cwd, 'cwd'),
          permission: permissionOf(input.permission ?? 'read-only'),
        })
        return { ok: true, value: { id: created.id } }
      }
      case 'mutate': {
        const id = string(payload.automationId, 'automationId')
        const mutation = string(payload.mutation, 'mutation')
        if (mutation === 'delete') {
          return { ok: true, value: await service.delete(id) }
        }
        if (mutation !== 'pause' && mutation !== 'resume') {
          throw new Error('mutation 必须是 pause、resume 或 delete')
        }
        const value = await service.update(id, { status: mutation === 'pause' ? 'paused' : 'active' })
        return { ok: true, value: { id: value.id, revision: value.revision } }
      }
      case 'update': {
        const id = string(payload.automationId, 'automationId')
        const input = record(payload.input, 'input')
        const updateInput: {
          name?: string
          prompt?: string
          cron?: string
          cwd?: string
          permission?: PermissionPreset
        } = {}
        const name = optionalString(input.name, 'name')
        const prompt = optionalString(input.prompt, 'prompt')
        const cron = optionalString(input.cron, 'cron')
        const cwd = optionalString(input.cwd, 'cwd')
        if (name !== undefined) updateInput.name = name
        if (prompt !== undefined) updateInput.prompt = prompt
        if (cron !== undefined) updateInput.cron = cron
        if (cwd !== undefined) updateInput.cwd = cwd
        if (input.permission !== undefined) updateInput.permission = permissionOf(input.permission)
        const value = await service.update(id, updateInput)
        return { ok: true, value: { id: value.id, revision: value.revision } }
      }
      case 'run-now': {
        const run = await service.runNow(string(payload.automationId, 'automationId'))
        return { ok: true, value: { runId: run.runId } }
      }
      default:
        throw new Error(`unknown endpoint '${endpoint}'`)
    }
  } catch (error) {
    return errorResult(error)
  }
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function readBody(req: NodeRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: NodeResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function failure(rpcId: string, code: string, message: string): Record<string, unknown> {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: { issues: [] } } } }
}

/**
 * 注册 RPC 路由。
 * @returns 释放函数（由调用方在插件卸载时执行）。
 */
export function registerAutomationRpc(ctx: RpcContext, service: CronSchedulerService): () => Promise<void> {
  const route = {
    kind: 'prefix' as const,
    path: RPC_CHANNEL,
    handler: async (req: NodeRequest, res: NodeResponse): Promise<void> => {
      // 信任栅栏 + 浏览器鉴权（与官方 route 一致；requestRejection 是 connection 服务的公开方法）
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const endpoint = endpointFromPath(RPC_CHANNEL, url.pathname)
      if (endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const rawType = req.headers['content-type']
      const mediaType = (Array.isArray(rawType) ? rawType[0] ?? '' : rawType ?? '').split(';')[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let body: unknown
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const envelope = (typeof body === 'object' && body !== null ? body : undefined) as
        | { readonly type?: unknown; readonly rpcId?: unknown; readonly method?: unknown; readonly payload?: unknown }
        | undefined
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : INVALID_REQUEST_RPC_ID
      if (envelope?.type !== 'client-request' || typeof envelope.method !== 'string') {
        writeJson(res, failure(rpcId, 'gateway/bad-request', 'invalid client-request message'))
        return
      }
      if (envelope.method !== endpoint) {
        writeJson(res, failure(rpcId, 'gateway/bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        const payload = typeof envelope.payload === 'object' && envelope.payload !== null
          ? envelope.payload as Record<string, unknown>
          : {}
        const result = await dispatch(service, endpoint, payload)
        writeJson(res, { type: 'server-response', rpcId, result })
      } catch (error) {
        res.writeHead(500)
        res.end(`handler failure: ${String(error)}`)
      }
    },
  }
  const dispose = ctx.effect(() => ctx.webServer.register(route), 'dsh-cron-scheduler: rpc route')
  return async () => {
    if (typeof dispose === 'function') await (dispose as () => unknown)()
  }
}
