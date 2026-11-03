import type { BridgeCdp } from './bridge-cdp'
import type { PassiveResponseLike } from '../../routes/career-browser'

/** Read-only network observation. No request interception, replay or cookie export. */
export class BridgeNetwork {
  private listeners = new Set<(response: PassiveResponseLike) => void>()
  private session: ReturnType<BridgeCdp['acquire']> | null = null
  private pending = new Set<Promise<unknown>>()

  constructor(private readonly cdp: BridgeCdp) {}

  on(listener: (response: PassiveResponseLike) => void): void {
    this.listeners.add(listener)
    if (this.session) return
    const activeListeners = this.listeners
    this.session = this.cdp.acquire().then(async session => {
      const requests = new Map<string, { method: string; response?: { url: string; status: number } }>()
      session.on('Network.requestWillBeSent', ((e: { requestId: string; request: { method: string } }) => {
        // Bound long-lived pages; collection itself also has a bounded duration/quota.
        if (requests.size > 1000) requests.clear()
        requests.set(e.requestId, { method: e.request.method })
      }) as (...args: never[]) => void)
      session.on('Network.responseReceived', ((e: { requestId: string; response: { url: string; status: number } }) => {
        const request = requests.get(e.requestId) ?? { method: 'GET' }
        request.response = e.response
        requests.set(e.requestId, request)
      }) as (...args: never[]) => void)
      session.on('Network.loadingFailed', ((e: { requestId: string }) => { requests.delete(e.requestId) }) as (...args: never[]) => void)
      session.on('Network.loadingFinished', ((e: { requestId: string }) => {
        const request = requests.get(e.requestId)
        requests.delete(e.requestId)
        if (!request?.response) return
        const response = request.response
        for (const listener of activeListeners) listener({
          url: () => response.url,
          status: () => response.status,
          request: () => ({ method: () => request.method }),
          json: () => {
            const result = session.send('Network.getResponseBody', { requestId: e.requestId }).then(raw => {
              const body = raw as { body: string; base64Encoded?: boolean }
              return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body) as unknown
            })
            this.pending.add(result)
            void result.then(() => this.pending.delete(result), () => this.pending.delete(result))
            return result
          },
        })
      }) as (...args: never[]) => void)
      try { await session.send('Network.enable', { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 }) }
      catch (error) { await session.detach(); throw error }
      return session
    })
    // The synchronous Page.on API cannot report async setup errors; collection stays empty.
    void this.session.catch(() => {})
  }

  off(listener: (response: PassiveResponseLike) => void): void {
    this.listeners.delete(listener)
    if (!this.listeners.size) void this.stop()
  }

  async stop(): Promise<void> {
    const opening = this.session
    this.session = null
    this.listeners.clear()
    this.listeners = new Set()
    const session = await opening?.catch(() => null)
    if (!session) return
    await Promise.allSettled([...this.pending])
    // Don't disable the Network domain: another consumer may already be observing it.
    await session.detach()
  }
}
