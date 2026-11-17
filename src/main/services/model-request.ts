import { chatRequest, type ChatBody } from '../../shared/model-protocol'
import { modelHeaders } from './settings'

/** Both wire protocols share timeouts, cancellation, and session headers. */
export function requestModel(base: string, key: string, body: ChatBody, session?: string, signal?: AbortSignal): Promise<Response> {
  const request = chatRequest(base, key, body)
  return fetch(request.url, {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', ...modelHeaders(base, session), ...request.headers },
    body: JSON.stringify(request.body)
  })
}
