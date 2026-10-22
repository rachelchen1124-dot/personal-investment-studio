// Server-only SEC transport. Never import this module into browser components.
import { defaultSecUserAgent } from './sec.ts'

export type SecStage = 'ticker-directory' | 'issuer-profile' | 'annual-report'
export class SecConnectionError extends Error {
  readonly code: string
  readonly stage: SecStage
  readonly httpStatus?: number
  readonly retryAt?: string
  constructor(
    code: string,
    stage: SecStage,
    message: string,
    httpStatus?: number,
    retryAt?: string
  ) {
    super(message)
    this.code = code
    this.stage = stage
    this.httpStatus = httpStatus
    this.retryAt = retryAt
    this.name = 'SecConnectionError'
  }
}

export function secRequestIdentity(input = process.env.SEC_USER_AGENT) {
  if (input && /[\r\n\0]/.test(input))
    throw new Error('SEC_USER_AGENT cannot contain control characters.')
  const userAgent = input?.trim() || defaultSecUserAgent
  if (
    userAgent.length < 16 ||
    userAgent.length > 500 ||
    /[\r\n\0]/.test(userAgent)
  )
    throw new Error(
      'SEC_USER_AGENT must identify the application and a real contact without control characters.'
    )
  return {
    userAgent,
    contactConfigured: /[^\s<>@;()]+@[^\s<>@;()]+\.[^\s<>@;()]+/.test(userAgent)
  }
}

type State = {
  queue: Promise<void>
  cooldown: Map<string, SecConnectionError>
  pending: Map<string, Promise<string>>
  cache: Map<string, { expires: number; text: string }>
}
const state = (): State => ({
  queue: Promise.resolve(),
  cooldown: new Map(),
  pending: new Map(),
  cache: new Map()
})
const shared = state()

async function boundedText(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error('SEC response exceeds the supported document size.')
  if (!response.body) throw new Error('SEC returned an empty response.')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let bytes = 0,
    text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit)
        throw new Error('SEC response exceeds the supported document size.')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
  }
}

/** One declared identity, fixed SEC hosts, coalesced requests and no 403 retries. */
export function createSecRequester(
  options: {
    fetcher?: typeof fetch
    userAgent?: string
    now?: () => number
  } = {}
) {
  const identity = secRequestIdentity(options.userAgent)
  const fetcher = options.fetcher ?? fetch
  // Injected fetchers get isolated state, so tests never suppress real requests.
  const current = options.fetcher ? state() : shared
  const now = options.now ?? Date.now
  async function request(
    url: string,
    stage: SecStage,
    limit = 8 * 1024 * 1024
  ): Promise<string> {
    const address = new URL(url)
    if (
      address.protocol !== 'https:' ||
      address.username ||
      address.password ||
      address.search ||
      address.port ||
      address.hash ||
      !['www.sec.gov', 'data.sec.gov'].includes(address.hostname)
    )
      throw new Error('Only fixed SEC HTTPS resources are supported.')
    const cached = current.cache.get(url)
    if (cached && cached.expires > now()) return cached.text
    const pending = current.pending.get(url)
    if (pending) return pending
    const operation = (async () => {
      const previous = current.queue
      let release!: () => void
      current.queue = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      let attempted = false
      try {
        const blocked = current.cooldown.get(address.origin)
        if (blocked?.retryAt && Date.parse(blocked.retryAt) > now())
          throw new SecConnectionError(
            blocked.code,
            stage,
            `SEC access is cooling down after HTTP ${blocked.httpStatus}. No repeated request was sent.`,
            blocked.httpStatus,
            blocked.retryAt
          )
        attempted = true
        const response = await fetcher(url, {
          headers: {
            'User-Agent': identity.userAgent,
            Accept: 'application/json,text/html',
            'Accept-Encoding': 'gzip, deflate'
          },
          signal: AbortSignal.timeout(15_000),
          redirect: 'error'
        })
        if (!response.ok) {
          const errorPage = (
            await boundedText(response, 128_000).catch(() => '')
          )
            .replaceAll(/<[^>]+>/g, ' ')
            .replaceAll(/\s+/g, ' ')
          const automationRejected =
            /undeclared automated tool|network of automated tools/i.test(
              errorPage
            )
          const retryHeader = response.headers.get('retry-after')
          const retryMs =
            retryHeader && /^\d+$/.test(retryHeader)
              ? Number(retryHeader) * 1000
              : retryHeader
                ? Math.max(0, Date.parse(retryHeader) - now())
                : 0
          const retryAt = [403, 429].includes(response.status)
            ? new Date(
                now() +
                  Math.max(600_000, Math.min(retryMs || 0, 24 * 60 * 60 * 1000))
              ).toISOString()
            : undefined
          const error = new SecConnectionError(
            response.status === 403
              ? automationRejected
                ? 'SEC_AUTOMATION_REJECTED'
                : 'SEC_FORBIDDEN'
              : response.status === 429
                ? 'SEC_RATE_LIMIT'
                : 'SEC_HTTP_ERROR',
            stage,
            `SEC ${stage.replaceAll('-', ' ')} returned HTTP ${response.status}.${automationRejected ? ' SEC identified the request as rejected automated traffic.' : ''}${retryAt ? ' Automated retries are paused for at least 10 minutes.' : ''}`,
            response.status,
            retryAt
          )
          // The response body can contain hosting/IP details; do not expose it.
          if (retryAt) current.cooldown.set(address.origin, error)
          throw error
        }
        const text = await boundedText(response, limit)
        if (stage !== 'annual-report') {
          try {
            JSON.parse(text)
          } catch {
            throw new SecConnectionError(
              'SEC_INVALID_RESPONSE',
              stage,
              'SEC returned a response that was not valid JSON.',
              response.status
            )
          }
          if (current.cache.size >= 12)
            current.cache.delete(current.cache.keys().next().value!)
          current.cache.set(url, { text, expires: now() + 10 * 60 * 1000 })
        }
        return text
      } catch (error) {
        if (error instanceof SecConnectionError) throw error
        throw new SecConnectionError(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'SEC_TIMEOUT'
            : 'SEC_CONNECTION_ERROR',
          stage,
          error instanceof Error && error.name === 'TimeoutError'
            ? 'The SEC request timed out.'
            : 'The SEC response could not be retrieved or read.'
        )
      } finally {
        // At most two requests per second in each warm server. No proxy rotation.
        if (attempted && !options.fetcher)
          await new Promise((resolve) => setTimeout(resolve, 500))
        release()
      }
    })()
    current.pending.set(url, operation)
    try {
      return await operation
    } finally {
      current.pending.delete(url)
    }
  }
  return { request, contactConfigured: identity.contactConfigured }
}
