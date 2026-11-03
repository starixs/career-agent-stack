import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createServer, type Server } from 'node:http'

/**
 * 迷你 RFC6455 WebSocket 服务端（零依赖——Node 22+ 的原生 WebSocket 只有客户端）。
 * 只覆盖扩展桥需要的能力：握手、文本帧（含分片）、ping/pong、close。
 * 只绑定 127.0.0.1，不在威胁模型里当公网服务。
 */

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA

export interface MiniWsHandlers {
  onMessage: (data: string) => void
  onClose?: () => void
}

export class MiniWsConnection {
  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private handlers: MiniWsHandlers | null = null
  private pending: string[] = []
  private closeSent = false
  private closed = false

  constructor(
    private readonly socket: Duplex,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      try { this.parseLoop() } catch (e) { this.log('[extension-bridge] ws parse error', e); this.close() }
    })
    socket.on('close', () => this.markClosed())
    socket.on('error', e => { this.log('[extension-bridge] ws socket error', e); this.markClosed() })
    // Duplex 类型上没有 setNoDelay（net.Socket 才有），可选调用
    ;(socket as import('node:net').Socket).setNoDelay?.(true)
  }

  /** 挂正式 handlers；之前的消息按序补投。 */
  attach(handlers: MiniWsHandlers): void {
    this.handlers = handlers
    for (const m of this.pending.splice(0)) handlers.onMessage(m)
  }

  isConnected(): boolean { return !this.closed }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.handlers?.onClose?.()
  }

  private parseLoop(): void {
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      const { opcode, payload, fin } = frame
      if (opcode === OP_PING) { this.writeFrame(OP_PONG, payload); continue }
      if (opcode === OP_PONG) continue
      if (opcode === OP_CLOSE) {
        if (!this.closeSent) { this.writeFrame(OP_CLOSE, payload); this.closeSent = true }
        this.socket.end(); return
      }
      if (opcode === OP_TEXT || opcode === OP_CONT) {
        this.fragments.push(payload)
        if (!fin) continue
        const whole = Buffer.concat(this.fragments)
        this.fragments = []
        const text = whole.toString('utf8')
        if (this.handlers) this.handlers.onMessage(text)
        else this.pending.push(text)
      }
    }
  }

  private readFrame(): { opcode: number; payload: Buffer; fin: boolean } | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (buf.length < off + 2) return null
      len = buf.readUInt16BE(off); off += 2
    } else if (len === 127) {
      if (buf.length < off + 8) return null
      const big = buf.readBigUInt64BE(off); off += 8
      if (big > 16n * 1024n * 1024n) throw new Error('ws frame too large')
      len = Number(big)
    }
    let mask: Buffer | null = null
    if (masked) {
      if (buf.length < off + 4) return null
      mask = buf.subarray(off, off + 4); off += 4
    }
    if (buf.length < off + len) return null
    let payload = buf.subarray(off, off + len)
    if (mask) {
      const out = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
      payload = out
    }
    this.buffer = buf.subarray(off + len)
    return { opcode, payload, fin }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return
    if (this.closeSent && opcode !== OP_CLOSE) return
    const len = payload.length
    let header: Buffer
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len])
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
    }
    try { this.socket.write(Buffer.concat([header, payload])) } catch (e) { this.log('[extension-bridge] ws write failed', e) }
  }

  sendText(text: string): void { this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8')) }

  close(): void {
    if (this.closeSent) return
    this.closeSent = true
    this.writeFrame(OP_CLOSE, Buffer.alloc(0))
    this.socket.end()
  }
}

export function acceptUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  log: (msg: string, err?: unknown) => void = () => {},
): MiniWsConnection {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') { socket.destroy(); throw new Error('missing sec-websocket-key') }
  const accept = createHash('sha1').update(key + MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  ;(socket as import('node:net').Socket).setNoDelay?.(true)
  return new MiniWsConnection(socket, log)
}

export interface MiniWsServer {
  port: number
  close(): Promise<void>
}

/** 起一个只收 WebSocket upgrade 的迷你 HTTP 服务（127.0.0.1）。makeHandlers 里可安全引用返回的 conn。 */
export function startMiniWsServer(
  host: string,
  port: number,
  makeHandlers: (conn: MiniWsConnection) => MiniWsHandlers,
  log: (msg: string, err?: unknown) => void = () => {},
): Promise<MiniWsServer> {
  const server: Server = createServer((req, res) => {
    // 探活请求（扩展 fetch 探端口是否活着；连不上扩展继续休眠轮询）
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => {
    try {
      const conn = acceptUpgrade(req, socket as Duplex, log)
      conn.attach(makeHandlers(conn))
    } catch (e) {
      log('[extension-bridge] upgrade failed', e)
      ;(socket as Duplex).destroy()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({
      port: (server.address() as { port: number }).port,
      close: () => new Promise<void>(res => server.close(() => res())),
    }))
  })
}
