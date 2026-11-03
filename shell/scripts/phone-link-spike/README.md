# 手机打通实测：蓝牙 MAP 读短信（不装 App）

一次性验证脚本，不是产品代码。macOS + IOBluetooth。

```sh
swiftc -O map-read.swift -o /tmp/map-read -framework IOBluetooth
swiftc -O pair.swift -o /tmp/bt-pair -framework IOBluetooth
/tmp/map-read <手机蓝牙地址>          # 读收件箱最新 3 条
/tmp/map-read <手机蓝牙地址> --poll   # 每 1.5 秒轮询新短信
```

接通方式（实测最稳）：Mac 打开「系统设置 → 蓝牙」→ 手机蓝牙里点 Mac 名字 → 核对数字点配对、Mac 点连接 → 手机「允许访问短信」。
`pair.swift`（Mac 发起、自动确认数字）首次可用，但失败后立即重试会让手机弹窗串号，产品里不要这样重试。

## 结果

| 日期 | 手机 | 系统 | 结果 |
|---|---|---|---|
| 2026-11-03 | 小米 10 | MIUI 12 / Android 10 | 通。验证码短信未被拦；正文、签名、发件号、时间齐全；新短信约 2 秒读到（轮询 1.5 秒，单条拉取 46ms） |
