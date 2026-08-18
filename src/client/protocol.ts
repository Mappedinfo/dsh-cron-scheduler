/** RPC 返回契约。 */

export interface RpcResult<T> {
  readonly ok: true
  readonly value: T
}

export interface RpcError {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> }
}

export function unwrapRpcResult<T>(response: unknown): T {
  const record = response as { readonly ok?: unknown; readonly value?: unknown; readonly error?: { readonly message?: unknown } } | undefined
  if (record?.ok === true) return record.value as T
  const message = typeof record?.error?.message === 'string' ? record.error.message : '未知错误'
  throw new Error(message)
}
