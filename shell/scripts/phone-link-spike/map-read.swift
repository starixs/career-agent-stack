import Foundation
import IOBluetooth

// 最小 MAP 客户端：SDP 找 MAS → RFCOMM → OBEX Connect → SetPath telecom/msg/inbox → 拉列表 → 拉最新正文；--poll 轮询新短信
let addr = CommandLine.arguments.count > 1 && !CommandLine.arguments[1].hasPrefix("--") ? CommandLine.arguments[1] : "e0-cc-f8-b6-28-12"
let pollMode = CommandLine.arguments.contains("--poll")
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

final class Chan: NSObject, IOBluetoothRFCOMMChannelDelegate {
  var buf = Data(); var opened = false; var closed = false
  func rfcommChannelData(_ c: IOBluetoothRFCOMMChannel!, data p: UnsafeMutableRawPointer!, length n: Int) { buf.append(Data(bytes: p, count: n)) }
  func rfcommChannelOpenComplete(_ c: IOBluetoothRFCOMMChannel!, status: IOReturn) { opened = status == kIOReturnSuccess; if !opened { closed = true }; log("rfcomm open status=\(status)") }
  func rfcommChannelClosed(_ c: IOBluetoothRFCOMMChannel!) { closed = true; log("rfcomm closed") }
}
func spin(_ secs: Double, until: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(secs)
  while Date() < end { if until() { return true }; RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
  return until()
}
func be16(_ v: Int) -> [UInt8] { [UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }
func hdrUnicode(_ id: UInt8, _ s: String) -> [UInt8] {
  var b: [UInt8] = []; if !s.isEmpty { for u in s.utf16 { b += be16(Int(u)) }; b += [0, 0] }
  return [id] + be16(3 + b.count) + b
}
func hdrBytes(_ id: UInt8, _ b: [UInt8]) -> [UInt8] { [id] + be16(3 + b.count) + b }
func hdr4(_ id: UInt8, _ v: UInt32) -> [UInt8] { [id, UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)] }

guard let dev = IOBluetoothDevice(addressString: addr) else { log("no device"); exit(2) }
log("device \(dev.name ?? "?") paired=\(dev.isPaired())")
var sdpDone = false
final class SDPDel: NSObject { @objc func sdpQueryComplete(_ d: IOBluetoothDevice!, status: IOReturn) { log("sdp status=\(status)"); sdpDone = true } }
let sd = SDPDel()
dev.performSDPQuery(sd)
_ = spin(20) { sdpDone }
let masUUID = IOBluetoothSDPUUID(uuid16: 0x1132)!
var chanID: BluetoothRFCOMMChannelID = 0
for rec in (dev.services as? [IOBluetoothSDPServiceRecord]) ?? [] {
  let nm = rec.getServiceName() ?? ""
  log("  svc: \(nm)")
  if rec.matchesUUIDArray([masUUID]) {
    var cid: BluetoothRFCOMMChannelID = 0
    if rec.getRFCOMMChannelID(&cid) == kIOReturnSuccess { log("MAS record '\(nm)' rfcomm=\(cid)"); if chanID == 0 { chanID = cid } }
  }
}
if chanID == 0 { log("no MAS service"); exit(3) }

let del = Chan()
var ch: IOBluetoothRFCOMMChannel? = nil
let r = dev.openRFCOMMChannelAsync(&ch, withChannelID: chanID, delegate: del)
log("openRFCOMM ret=\(r)")
guard spin(60, until: { del.opened || del.closed }), del.opened, let chan = ch else { log("rfcomm failed"); exit(4) }

func send(_ pkt: [UInt8], wait: Double = 60) -> (UInt8, [UInt8]) {
  del.buf.removeAll()
  var p = pkt
  let rr = chan.writeSync(&p, length: UInt16(p.count))
  if rr != kIOReturnSuccess { log("write err \(rr)") }
  _ = spin(wait) { (del.buf.count >= 3 && del.buf.count >= (Int(del.buf[1]) << 8 | Int(del.buf[2]))) || del.closed }
  let b = [UInt8](del.buf)
  if b.count < 3 { return (0, []) }
  return (b[0], b)
}
func headers(_ b: [UInt8], from: Int) -> [(UInt8, [UInt8])] {
  var i = from; var out: [(UInt8, [UInt8])] = []
  while i < b.count {
    let id = b[i]
    switch id >> 6 {
    case 0, 1:
      guard i + 2 < b.count else { return out }
      let l = Int(b[i+1]) << 8 | Int(b[i+2]); out.append((id, Array(b[(i+3)..<min(b.count, i+l)]))); i += max(l, 3)
    case 2: out.append((id, [b[min(i+1, b.count-1)]])); i += 2
    default: out.append((id, Array(b[(i+1)..<min(b.count, i+5)]))); i += 5
    }
  }
  return out
}
let target: [UInt8] = [0xBB,0x58,0x2B,0x40,0x42,0x0C,0x11,0xDB,0xB0,0xDE,0x08,0x00,0x20,0x0C,0x9A,0x66]
var body: [UInt8] = [0x10, 0x00] + be16(0x0800) + hdrBytes(0x46, target)
log("OBEX connect (phone may ask to allow message access — 请在手机上点允许)")
var (op, resp) = send([0x80] + be16(3 + body.count) + body, wait: 90)
log(String(format: "connect resp=0x%02x", op))
guard op == 0xA0 else { log("connect refused"); exit(5) }
var connID: UInt32 = 0
for (id, v) in headers(resp, from: 7) where id == 0xCB && v.count == 4 { connID = UInt32(v[0]) << 24 | UInt32(v[1]) << 16 | UInt32(v[2]) << 8 | UInt32(v[3]) }
log("connID=\(connID)")
for f in ["telecom", "msg", "inbox"] {
  body = [0x02, 0x00] + hdr4(0xCB, connID) + hdrUnicode(0x01, f)
  (op, _) = send([0x85] + be16(3 + body.count) + body)
  log(String(format: "setpath %@ resp=0x%02x", f, op))
}
func get(type: String, name: String, app: [UInt8]) -> String {
  var acc: [UInt8] = []
  body = hdr4(0xCB, connID) + hdrBytes(0x42, Array(type.utf8) + [0]) + hdrUnicode(0x01, name) + (app.isEmpty ? [] : hdrBytes(0x4C, app))
  var pkt = [0x83] + be16(3 + body.count) + body
  while true {
    (op, resp) = send(pkt)
    for (id, v) in headers(resp, from: 3) where id == 0x48 || id == 0x49 { acc += v }
    if op == 0x90 { body = hdr4(0xCB, connID); pkt = [0x83] + be16(3 + body.count) + body; continue }
    if op != 0xA0 { log(String(format: "get %@ resp=0x%02x", type, op)) }
    break
  }
  return String(decoding: acc, as: UTF8.self)
}
func listing(_ n: Int) -> [(String, String)] {
  let xml = get(type: "x-bt/MAP-msg-listing", name: "", app: [0x01, 0x02] + be16(n) + [0x13, 0x01, 200])
  var out: [(String, String)] = []
  let rx = try! NSRegularExpression(pattern: "<msg [^>]*handle\\s*=\\s*\"([^\"]+)\"[^>]*>", options: [])
  for m in rx.matches(in: xml, range: NSRange(xml.startIndex..., in: xml)) {
    out.append((String(xml[Range(m.range(at: 1), in: xml)!]), String(xml[Range(m.range, in: xml)!])))
  }
  if out.isEmpty { log("raw listing: \(xml.prefix(600))") }
  return out
}
func message(_ h: String) -> String { get(type: "x-bt/message", name: h, app: [0x0A, 0x01, 0x00, 0x14, 0x01, 0x01]) }

let first = listing(3)
log("inbox newest \(first.count)")
for (_, w) in first { print("LIST \(w)") }
if let h = first.first?.0 { print("BODY of \(h):\n\(message(h))") }
fflush(stdout)
if pollMode {
  var seen = Set(listing(20).map { $0.0 })
  log("polling for new SMS ...")
  while !del.closed {
    _ = spin(1.5) { false }
    for (h, w) in listing(5) where !seen.contains(h) {
      seen.insert(h)
      let t0 = Date()
      let m = message(h)
      print("NEW \(ISO8601DateFormatter().string(from: Date())) \(w)\n\(m)\n(fetch \(Int(Date().timeIntervalSince(t0) * 1000))ms)"); fflush(stdout)
    }
  }
}
