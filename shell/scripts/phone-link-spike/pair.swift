import Foundation
import IOBluetooth

// 发起配对，数字比对 / 确认请求自动回「是」；最多重试 6 次（每次约 40 秒），手机端要人点「配对」
let addr = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "e0-cc-f8-b6-28-12"
func log(_ s: String) { print(s); fflush(stdout) }

final class PD: NSObject, IOBluetoothDevicePairDelegate {
  var done = false; var err: IOReturn = 0
  func devicePairingStarted(_ sender: Any!) { log("pairing started") }
  func devicePairingConnecting(_ sender: Any!) { log("connecting") }
  func devicePairingUserConfirmationRequest(_ sender: Any!, numericValue: BluetoothNumericValue) {
    log("confirm number \(String(format: "%06d", numericValue)) → yes")
    (sender as? IOBluetoothDevicePair)?.replyUserConfirmation(true)
  }
  func devicePairingPINCodeRequest(_ sender: Any!) { log("PIN requested (unexpected)") }
  func devicePairingUserPasskeyNotification(_ sender: Any!, passkey: BluetoothPasskey) { log("passkey \(passkey)") }
  func devicePairingFinished(_ sender: Any!, error: IOReturn) { err = error; done = true; log("pairing finished err=\(error)") }
  func deviceSimplePairingComplete(_ sender: Any!, status: BluetoothHCIEventStatus) { log("simple pairing complete status=\(status)") }
}

guard let dev = IOBluetoothDevice(addressString: addr) else { log("no device"); exit(2) }
for i in 1...6 {
  if dev.isPaired() { break }
  log("attempt \(i) \(Date())")
  let d = PD()
  guard let p = IOBluetoothDevicePair(device: dev) else { exit(3) }
  p.delegate = d
  let r = p.start()
  if r != kIOReturnSuccess { log("start ret=\(r)") }
  let end = Date().addingTimeInterval(45)
  while !d.done && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  if !d.done { p.stop(); log("timeout") }
  if dev.isPaired() { break }
  Thread.sleep(forTimeInterval: 2)
}
log("paired=\(dev.isPaired())")
exit(dev.isPaired() ? 0 : 1)
