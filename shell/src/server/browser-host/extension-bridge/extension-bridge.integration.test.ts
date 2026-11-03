import { afterAll, describe, expect, it, beforeAll } from 'vitest'
import { ExtensionBridge } from './extension-bridge'

/**
 * 扩展桥集成测试：真实回环 socket + 原生 WebSocket 客户端扮演 career-bridge 扩展，
 * 把 ws-mini 的握手 / 帧 / 协议（ext_ready → ack → result）整个跑一遍。
 */

let bridge: ExtensionBridge
let client: WebSocket
let port: number

const nextMessage = (ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待扩展桥消息超时')), timeoutMs)
    ws.addEventListener('message', ev => {
      clearTimeout(timer)
      resolve(JSON.parse(String(ev.data)) as Record<string, unknown>)
    }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')) }, { once: true })
  })

beforeAll(async () => {
  const tryPort = 21000 + Math.floor(Math.random() * 20000)
  bridge = await ExtensionBridge.start({ port: tryPort })
  port = tryPort
})

afterAll(async () => {
  client?.close()
  await bridge?.stop()
})

describe('ExtensionBridge 端到端协议', () => {
  it('扩展连入 + ext_ready → 标签可见、isConnected', async () => {
    client = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { client.addEventListener('open', () => res(), { once: true }); client.addEventListener('error', () => rej(new Error('connect failed')), { once: true }) })
    client.send(JSON.stringify({ type: 'ext_ready', tabs: [{ id: 7, url: 'https://www.zhipin.com/apply', title: '投递' }, { id: 8, url: 'https://example.com', title: '' }] }))
    await new Promise(r => setTimeout(r, 100))
    expect(bridge.isConnected()).toBe(true)
    expect(bridge.tabs().map(t => t.id)).toEqual([7, 8])
    expect(bridge.findTab('zhipin')?.id).toBe(7)
  })

  it('executeJs：id/tabId/code 下发 → ack → result 回传', async () => {
    const pending = bridge.executeJs(7, 'return 1 + 1')
    const req = await nextMessage(client)
    expect(req).toMatchObject({ tabId: 7, code: 'return 1 + 1' })
    expect(typeof req.id).toBe('string')
    client.send(JSON.stringify({ type: 'ack', id: req.id }))
    client.send(JSON.stringify({ type: 'result', id: req.id, result: 2, newTabs: [{ id: 9, url: 'https://new.tab', title: '新页' }] }))
    const res = await pending
    expect(res.data).toBe(2)
    expect(res.newTabs?.[0]?.url).toBe('https://new.tab')
  })

  it('error 回传 → executeJs 拒绝', async () => {
    const pending = bridge.executeJs(7, 'boom()')
    const req = await nextMessage(client)
    client.send(JSON.stringify({ type: 'error', id: req.id, error: 'boom is not defined' }))
    await expect(pending).rejects.toThrow('boom is not defined')
  })

  it('sendCommand：cmd 路由原样往返', async () => {
    const pending = bridge.sendCommand({ cmd: 'cookies', url: 'https://www.zhipin.com' })
    const req = await nextMessage(client)
    expect(req).toMatchObject({ cmd: 'cookies', url: 'https://www.zhipin.com' })
    client.send(JSON.stringify({ type: 'result', id: req.id, result: [{ name: 'token', value: 'x' }] }))
    await expect(pending).resolves.toEqual([{ name: 'token', value: 'x' }])
  })

  it('cdp_event / cdp_detached 上行 → onCdpEvent 订阅者收到', async () => {
    const seen: Array<Record<string, unknown>> = []
    const off = bridge.onCdpEvent(e => seen.push(e as unknown as Record<string, unknown>))
    client.send(JSON.stringify({ type: 'cdp_event', tabId: 7, method: 'Page.screencastFrame', params: { data: 'aGk=' } }))
    client.send(JSON.stringify({ type: 'cdp_detached', tabId: 7, reason: 'canceled_by_user' }))
    await new Promise(r => setTimeout(r, 100))
    off()
    expect(seen.length).toBe(2)
    expect(seen[0]).toMatchObject({ kind: 'event', tabId: 7, method: 'Page.screencastFrame' })
    expect((seen[0] as { params: { data: string } }).params.data).toBe('aGk=')
    expect(seen[1]).toMatchObject({ kind: 'detached', tabId: 7, reason: 'canceled_by_user' })
  })

  it('没发过消息的杂散连接断开不误伤主会话（onDisconnect 不触发）', async () => {
    const probe = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { probe.addEventListener('open', () => res(), { once: true }); probe.addEventListener('error', () => rej(new Error('connect failed')), { once: true }) })
    let disconnected = false
    const off = bridge.onDisconnect(() => { disconnected = true })
    probe.close() // 杂散连接：从未发过消息，不占主会话位
    await new Promise(r => setTimeout(r, 150))
    off()
    expect(disconnected).toBe(false)
    expect(bridge.isConnected()).toBe(true) // 主客户端还在线
  })

  it('扩展断开 → isConnected false，在途请求在 stop 时拒绝', async () => {
    const inFlight = bridge.executeJs(7, 'slow()')
    const req = await nextMessage(client)
    void req
    client.close()
    await new Promise(r => setTimeout(r, 150))
    expect(bridge.isConnected()).toBe(false)
    await expect(bridge.stop()).resolves.toBeUndefined()
    await expect(inFlight).rejects.toThrow()
    await expect(bridge.executeJs(7, 'x')).rejects.toThrow('扩展未连接')
  })
})
