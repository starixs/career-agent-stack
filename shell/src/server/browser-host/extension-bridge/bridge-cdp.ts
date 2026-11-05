import type { BridgeLike, BridgeEventSource } from './bridge-driver'
import type { BridgeCdpEvent } from './extension-bridge'

/** One debugger attachment per tab; input and preview borrow it independently. */
export class BridgeCdp {
  private users = 0
  private attached = false
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private streams = 0
  private lastAck: { id: unknown; result: Promise<unknown> } | null = null
  private readonly off: Array<() => void> = []

  constructor(private readonly bridge: BridgeLike & Partial<BridgeEventSource>, private readonly tabId: number) {
    const invalidate = () => { this.attached = false; this.streams = 0; this.lastAck = null; this.generation++ }
    if (bridge.onDisconnect) this.off.push(bridge.onDisconnect(invalidate))
    if (bridge.onCdpEvent) this.off.push(bridge.onCdpEvent(e => { if (e.tabId === tabId && e.kind === 'detached') invalidate() }))
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn)
    this.queue = result.catch(() => {})
    return result
  }

  async acquire() {
    await this.serial(async () => {
      if (!this.attached) {
        await this.bridge.sendCommand({ cmd: 'cdp_attach', tabId: this.tabId })
        this.attached = true
      }
      this.users++
    })
    const generation = this.generation
    let released = false
    let streaming = false
    const stopStream = async () => {
      if (!streaming) return
      streaming = false
      if (generation !== this.generation) return
      this.streams--
      if (!this.streams && this.attached) await this.bridge.sendCommand({ cmd: 'cdp', tabId: this.tabId, method: 'Page.stopScreencast' }).catch(() => {})
    }
    const listeners = new Map<string, Map<(...args: never[]) => void, () => void>>()
    return {
      send: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (released || generation !== this.generation) return Promise.reject(new Error('Browser debugger session detached'))
        if (method === 'Page.startScreencast') return this.serial(async () => {
          if (released || generation !== this.generation) throw new Error('Browser debugger session detached')
          if (streaming) return {}
          if (!this.streams) {
            this.lastAck = null
            await this.bridge.sendCommand({ cmd: 'cdp', tabId: this.tabId, method, params: params ?? {} })
          }
          streaming = true; this.streams++
          return {}
        })
        if (method === 'Page.stopScreencast') return this.serial(stopStream)
        if (method === 'Page.screencastFrameAck') {
          if (this.lastAck && this.lastAck.id === params?.sessionId) return this.lastAck.result
          const result = this.bridge.sendCommand({ cmd: 'cdp', tabId: this.tabId, method, params: params ?? {} })
          this.lastAck = { id: params?.sessionId, result }
          return result
        }
        const started = Date.now()
        const note = () => {
          const ms = Date.now() - started
          if (ms > 3000) console.warn(`[bridge-cdp] slow ${method}${typeof params?.type === 'string' ? `:${params.type}` : ''} ${ms}ms`)
        }
        const sent = this.bridge.sendCommand({ cmd: 'cdp', tabId: this.tabId, method, params: params ?? {} })
        sent.then(note, note)
        return sent
      },
      on: (method: string, listener: (...args: never[]) => void) => {
        if (released || !this.bridge.onCdpEvent) return
        const callbacks = listeners.get(method) ?? new Map()
        callbacks.get(listener)?.()
        callbacks.set(listener, this.bridge.onCdpEvent((e: BridgeCdpEvent) => {
          if (!released && generation === this.generation && e.tabId === this.tabId && e.method === method) listener(e.params as never)
        }))
        listeners.set(method, callbacks)
      },
      off: (method: string, listener: (...args: never[]) => void) => {
        listeners.get(method)?.get(listener)?.()
        listeners.get(method)?.delete(listener)
      },
      detach: async () => {
        if (released) return
        released = true
        for (const callbacks of listeners.values()) for (const off of callbacks.values()) off()
        listeners.clear()
        await this.serial(async () => {
          await stopStream()
          this.users--
          if (!this.users && this.attached) {
            this.attached = false
            await this.bridge.sendCommand({ cmd: 'cdp_detach', tabId: this.tabId }).catch(() => {})
          }
        })
      },
    }
  }

  dispose(): void { for (const off of this.off) off(); this.off.length = 0; this.generation++ }
}
