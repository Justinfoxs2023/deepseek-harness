/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */

import { isContextWindowExceededError, isQuotaExceededError, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'

/** The provider fields a failure body may carry. */
interface ProviderErrorFields {
  readonly code?: string
  readonly type?: string
  readonly message?: string
}

/**
 * Read the provider's error fields from a decoded body.
 *
 * OpenAI-compatible providers wrap the fields in an `error` object; other
 * providers and the gateways in front of them return the same fields flat.
 * A body whose shape this reader does not know loses the provider's message
 * and type, and the classification that follows depends on both: a
 * context-window rejection then reads as a generic bad request, so the
 * harness never compacts and retries the request it just rejected.
 * @param raw - decoded HTTP error response or in-band error event.
 * @returns the error fields the body carries, or undefined when it carries none.
 */
export function providerErrorFields(raw: unknown): ProviderErrorFields | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const wrapped = record['error']
  const source = typeof wrapped === 'object' && wrapped !== null
    ? wrapped as Record<string, unknown>
    : record
  const code = typeof source['code'] === 'string' ? source['code'] : undefined
  const type = typeof source['type'] === 'string' ? source['type'] : undefined
  const message = typeof source['message'] === 'string' ? source['message'] : undefined
  if (code === undefined && type === undefined && message === undefined) return undefined
  return {
    ...code === undefined ? {} : { code },
    ...type === undefined ? {} : { type },
    ...message === undefined ? {} : { message },
  }
}

/** Read only provider error fields used by bounded Files recovery.
 * @param raw - decoded HTTP error response.
 * @returns code, type, and message text, without unrelated response fields.
 */
export function providerErrorDetail(raw: unknown): string {
  const fields = providerErrorFields(raw)
  if (fields === undefined) return ''
  return [fields.code, fields.type, fields.message]
    .filter((value): value is string => value !== undefined)
    .join(' ')
}

/** Classify a provider error without trusting arbitrary response fields.
 * @param raw - decoded response or in-band error event.
 * @param status - HTTP status when the error preceded streaming.
 * @param headers - response headers for retry delay and request identity.
 * @returns a stable error consumed by LlmRuntime and llm-retry.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const fields = providerErrorFields(raw)
  const message = fields?.message ?? `DeepSeek Messages request failed (${status ?? 'stream error'})`
  const type = fields?.type ?? ''
  const detail = `${type} ${fields?.code ?? ''} ${message}`
  let code: string
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error'].includes(type)) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST'
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const retry = headers?.get('retry-after')
  const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id')
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id ? { requestId: ProviderRequestId(id) } : {},
    ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
  })
}
