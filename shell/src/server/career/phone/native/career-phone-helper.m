// career-phone-helper：用蓝牙短信读取（MAP，车机读短信那套）从已配对手机收验证码。手机上不装 App。
// 由宿主启动，stdin 关闭即退出；输出一行一个 JSON 事件（{"ev": ...}）。构建期由
// scripts/prepare-phone-helper.mjs 预编译进安装包（源码：src/server/career/phone/native/）。
//
// 子命令：
//   devices            列出已配对设备后退出：{"ev":"devices","list":[{address,name,connected,phone}]}
//   wait-pair          以当前已配对列表为基线，等手机端发起的新配对：{"ev":"paired",address,name} 后退出
//   link <address>     常驻：连接手机的短信服务（MAS），状态 {"ev":"link","state":...}；
//                      连上后报一次最近一条验证码短信（{"ev":"latest",...} 或 sms 为 null），之后轮询收件箱，
//                      新到的验证码短信报 {"ev":"sms",handle,sender,time,body}。断线按 3s→30s 退避重连。
//
// 隐私：只上报像验证码的短信（正文含 验证码 / 校验码 / 动态码 / code 等）；别的短信不出这个进程。
// 列表里的摘要会被部分手机截到 20 字左右（华为实测），所以正文一律单条拉取，不用摘要取码。
#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>

static void emit(NSDictionary *obj) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!data) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

// stdin EOF = 宿主走了，跟着退出。全局持有事件源，防止 ARC 释放。
static dispatch_source_t gStdinSource;
static void exitOnStdinClose(void) {
  dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(src, ^{
    char buf[512];
    if (read(STDIN_FILENO, buf, sizeof buf) <= 0) exit(0);
  });
  dispatch_resume(src);
  gStdinSource = src;
}

static BOOL spin(NSTimeInterval secs, BOOL (^until)(void)) {
  NSDate *end = [NSDate dateWithTimeIntervalSinceNow:secs];
  while ([end timeIntervalSinceNow] > 0) {
    if (until && until()) return YES;
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  return until ? until() : NO;
}

static BOOL isPhone(IOBluetoothDevice *d) { return d.deviceClassMajor == kBluetoothDeviceClassMajorPhone; }

static NSDictionary *deviceInfo(IOBluetoothDevice *d) {
  return @{ @"address": d.addressString ?: @"", @"name": d.name ?: @"", @"connected": @(d.isConnected), @"phone": @(isPhone(d)) };
}

// ---------------- devices / wait-pair ----------------

static int cmdDevices(void) {
  // pairedDevices 会重复返回同一台设备（实测），按地址去重
  NSMutableArray *list = [NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  for (IOBluetoothDevice *d in [IOBluetoothDevice pairedDevices] ?: @[]) {
    if (!d.addressString || [seen containsObject:d.addressString]) continue;
    [seen addObject:d.addressString];
    [list addObject:deviceInfo(d)];
  }
  emit(@{ @"ev": @"devices", @"list": list });
  return 0;
}

static int cmdWaitPair(void) {
  NSMutableSet *baseline = [NSMutableSet set];
  for (IOBluetoothDevice *d in [IOBluetoothDevice pairedDevices] ?: @[]) [baseline addObject:d.addressString ?: @""];
  emit(@{ @"ev": @"waiting" });
  for (;;) {
    spin(1.0, nil);
    for (IOBluetoothDevice *d in [IOBluetoothDevice pairedDevices] ?: @[]) {
      if ([baseline containsObject:d.addressString ?: @""]) continue;
      NSMutableDictionary *info = [deviceInfo(d) mutableCopy];
      info[@"ev"] = @"paired";
      emit(info);
      return 0;
    }
  }
}

// ---------------- OBEX / MAP ----------------

@interface Chan : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) NSMutableData *buf;
@property (nonatomic) BOOL opened;
@property (nonatomic) BOOL closed;
@end
@implementation Chan
- (instancetype)init { if ((self = [super init])) _buf = [NSMutableData data]; return self; }
- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)c data:(void *)p length:(size_t)n { [self.buf appendBytes:p length:n]; }
- (void)rfcommChannelOpenComplete:(IOBluetoothRFCOMMChannel *)c status:(IOReturn)status {
  if (status == kIOReturnSuccess) self.opened = YES; else self.closed = YES;
}
- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)c { self.closed = YES; }
@end

@interface SDPWait : NSObject
@property (nonatomic) BOOL done;
@end
@implementation SDPWait
- (void)sdpQueryComplete:(IOBluetoothDevice *)d status:(IOReturn)status { self.done = YES; }
@end

static void put16(NSMutableData *d, NSUInteger v) { uint8_t b[2] = { (uint8_t)(v >> 8), (uint8_t)v }; [d appendBytes:b length:2]; }
static void hdrBytes(NSMutableData *d, uint8_t hid, NSData *payload) {
  [d appendBytes:&hid length:1]; put16(d, 3 + payload.length); [d appendData:payload];
}
static void hdrUnicode(NSMutableData *d, uint8_t hid, NSString *s) {
  NSMutableData *p = [NSMutableData data];
  if (s.length) {
    for (NSUInteger i = 0; i < s.length; i++) put16(p, [s characterAtIndex:i]);
    put16(p, 0);
  }
  hdrBytes(d, hid, p);
}
static void hdr4(NSMutableData *d, uint8_t hid, uint32_t v) {
  uint8_t b[5] = { hid, (uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v };
  [d appendBytes:b length:5];
}
static NSData *packet(uint8_t op, NSData *body) {
  NSMutableData *p = [NSMutableData dataWithBytes:&op length:1];
  put16(p, 3 + body.length); [p appendData:body];
  return p;
}

@interface MapLink : NSObject
@property (nonatomic, strong) IOBluetoothDevice *dev;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel *chan;
@property (nonatomic, strong) Chan *del;
@property (nonatomic) uint32_t connID;
@end

@implementation MapLink

// 发一个 OBEX 包，等完整响应。返回响应字节；断开或超时返回 nil。
- (NSData *)send:(NSData *)pkt wait:(NSTimeInterval)wait {
  [self.del.buf setLength:0];
  IOReturn r = [self.chan writeSync:(void *)pkt.bytes length:(UInt16)pkt.length];
  if (r != kIOReturnSuccess) return nil;
  Chan *del = self.del;
  spin(wait, ^BOOL {
    if (del.closed) return YES;
    if (del.buf.length < 3) return NO;
    const uint8_t *b = del.buf.bytes;
    return del.buf.length >= (NSUInteger)((b[1] << 8) | b[2]);
  });
  if (self.del.buf.length < 3) return nil;
  return [self.del.buf copy];
}

static void eachHeader(NSData *resp, NSUInteger from, void (^fn)(uint8_t hid, NSData *v)) {
  const uint8_t *b = resp.bytes; NSUInteger n = resp.length, i = from;
  while (i < n) {
    uint8_t hid = b[i];
    switch (hid >> 6) {
      case 0: case 1: {
        if (i + 2 >= n) return;
        NSUInteger l = (b[i + 1] << 8) | b[i + 2];
        if (l < 3) return;
        NSUInteger end = MIN(n, i + l);
        fn(hid, [resp subdataWithRange:NSMakeRange(i + 3, end - (i + 3))]);
        i += l; break;
      }
      case 2: if (i + 1 < n) fn(hid, [resp subdataWithRange:NSMakeRange(i + 1, 1)]); i += 2; break;
      default: if (i + 4 < n) fn(hid, [resp subdataWithRange:NSMakeRange(i + 1, 4)]); i += 5; break;
    }
  }
}

// 返回 nil 表示成功；否则是失败状态（unsupported / refused / unreachable）。
- (NSString *)open {
  SDPWait *w = [SDPWait new];
  [self.dev performSDPQuery:w];
  spin(20, ^BOOL { return w.done; });
  IOBluetoothSDPUUID *mas = [IOBluetoothSDPUUID uuid16:0x1132];
  BluetoothRFCOMMChannelID cid = 0;
  for (IOBluetoothSDPServiceRecord *rec in self.dev.services ?: @[]) {
    if (![rec matchesUUIDArray:@[mas]]) continue;
    BluetoothRFCOMMChannelID c = 0;
    if ([rec getRFCOMMChannelID:&c] == kIOReturnSuccess) { cid = c; break; }
  }
  if (cid == 0) return w.done && self.dev.services.count ? @"unsupported" : @"unreachable";

  self.del = [Chan new];
  IOBluetoothRFCOMMChannel *ch = nil;
  if ([self.dev openRFCOMMChannelAsync:&ch withChannelID:cid delegate:self.del] != kIOReturnSuccess) return @"unreachable";
  Chan *del = self.del;
  spin(60, ^BOOL { return del.opened || del.closed; });
  if (!self.del.opened || !ch) return @"unreachable";
  self.chan = ch;

  static const uint8_t target[16] = { 0xBB,0x58,0x2B,0x40,0x42,0x0C,0x11,0xDB,0xB0,0xDE,0x08,0x00,0x20,0x0C,0x9A,0x66 };
  NSMutableData *body = [NSMutableData dataWithBytes:(uint8_t[]){ 0x10, 0x00 } length:2];
  put16(body, 0x0800);
  hdrBytes(body, 0x46, [NSData dataWithBytes:target length:16]);
  // 手机可能在这里弹「允许访问短信」，给足时间
  NSData *resp = [self send:packet(0x80, body) wait:90];
  if (!resp || ((const uint8_t *)resp.bytes)[0] != 0xA0) { [self close]; return @"refused"; }
  __block uint32_t connID = 0;
  eachHeader(resp, 7, ^(uint8_t hid, NSData *v) {
    if (hid == 0xCB && v.length == 4) { const uint8_t *x = v.bytes; connID = (uint32_t)x[0] << 24 | (uint32_t)x[1] << 16 | (uint32_t)x[2] << 8 | x[3]; }
  });
  self.connID = connID;
  for (NSString *f in @[ @"telecom", @"msg", @"inbox" ]) {
    NSMutableData *b = [NSMutableData dataWithBytes:(uint8_t[]){ 0x02, 0x00 } length:2];
    hdr4(b, 0xCB, connID); hdrUnicode(b, 0x01, f);
    NSData *r = [self send:packet(0x85, b) wait:30];
    if (!r || ((const uint8_t *)r.bytes)[0] != 0xA0) { [self close]; return @"refused"; }
  }
  return nil;
}

- (void)close { [self.chan closeChannel]; self.chan = nil; }
- (BOOL)alive { return self.chan && !self.del.closed; }

- (NSString *)getType:(NSString *)type name:(NSString *)name app:(NSData *)app {
  NSMutableData *acc = [NSMutableData data];
  NSMutableData *body = [NSMutableData data];
  hdr4(body, 0xCB, self.connID);
  NSMutableData *t = [[type dataUsingEncoding:NSUTF8StringEncoding] mutableCopy]; [t appendBytes:"\0" length:1];
  hdrBytes(body, 0x42, t); hdrUnicode(body, 0x01, name);
  if (app.length) hdrBytes(body, 0x4C, app);
  NSData *pkt = packet(0x83, body);
  for (int guard = 0; guard < 200; guard++) {
    NSData *resp = [self send:pkt wait:30];
    if (!resp) return nil;
    eachHeader(resp, 3, ^(uint8_t hid, NSData *v) { if (hid == 0x48 || hid == 0x49) [acc appendData:v]; });
    uint8_t op = ((const uint8_t *)resp.bytes)[0];
    if (op == 0x90) { NSMutableData *b = [NSMutableData data]; hdr4(b, 0xCB, self.connID); pkt = packet(0x83, b); continue; }
    if (op != 0xA0) return nil;
    break;
  }
  return [[NSString alloc] initWithData:acc encoding:NSUTF8StringEncoding] ?: @"";
}

static NSString *attr(NSString *tag, NSString *name) {
  NSString *pat = [NSString stringWithFormat:@"%@\\s*=\\s*\"([^\"]*)\"", name];
  NSRegularExpression *rx = [NSRegularExpression regularExpressionWithPattern:pat options:0 error:nil];
  NSTextCheckingResult *m = [rx firstMatchInString:tag options:0 range:NSMakeRange(0, tag.length)];
  return m ? [tag substringWithRange:[m rangeAtIndex:1]] : @"";
}

// 收件箱最新 n 条：[{handle, sender, time}]，新的在前。nil = 连接出错。
- (NSArray<NSDictionary *> *)listing:(NSUInteger)n {
  NSMutableData *app = [NSMutableData dataWithBytes:(uint8_t[]){ 0x01, 0x02 } length:2];
  put16(app, n);
  NSString *xml = [self getType:@"x-bt/MAP-msg-listing" name:@"" app:app];
  if (!xml) return nil;
  NSRegularExpression *rx = [NSRegularExpression regularExpressionWithPattern:@"<msg\\s[^>]*>" options:0 error:nil];
  NSMutableArray *out = [NSMutableArray array];
  for (NSTextCheckingResult *m in [rx matchesInString:xml options:0 range:NSMakeRange(0, xml.length)]) {
    NSString *tag = [xml substringWithRange:m.range];
    NSString *h = attr(tag, @"handle");
    if (!h.length) continue;
    [out addObject:@{ @"handle": h, @"sender": attr(tag, @"sender_addressing"), @"time": attr(tag, @"datetime") }];
  }
  return out;
}

// 单条正文（bMessage 里 BEGIN:MSG 与 END:MSG 之间）。nil = 连接出错。
- (NSString *)body:(NSString *)handle {
  // Attachment=0（0x0A）、Charset=UTF-8（0x14）
  NSData *app = [NSData dataWithBytes:(uint8_t[]){ 0x0A, 0x01, 0x00, 0x14, 0x01, 0x01 } length:6];
  NSString *b = [self getType:@"x-bt/message" name:handle app:app];
  if (!b) return nil;
  NSRange s = [b rangeOfString:@"BEGIN:MSG"], e = [b rangeOfString:@"END:MSG" options:NSBackwardsSearch];
  if (s.location == NSNotFound || e.location == NSNotFound || e.location <= NSMaxRange(s)) return @"";
  return [[b substringWithRange:NSMakeRange(NSMaxRange(s), e.location - NSMaxRange(s))]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}
@end

static BOOL looksLikeCode(NSString *body) {
  static NSRegularExpression *kw, *digits;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    kw = [NSRegularExpression regularExpressionWithPattern:@"(验证码|校验码|动态码|确认码|驗證碼|激活码|verification|code|OTP)" options:NSRegularExpressionCaseInsensitive error:nil];
    digits = [NSRegularExpression regularExpressionWithPattern:@"[0-9A-Za-z]{4,8}" options:0 error:nil];
  });
  NSRange all = NSMakeRange(0, body.length);
  return [kw firstMatchInString:body options:0 range:all] && [digits firstMatchInString:body options:0 range:all];
}

static NSDictionary *smsEvent(NSString *ev, NSDictionary *item, NSString *body) {
  return @{ @"ev": ev, @"handle": item[@"handle"], @"sender": item[@"sender"], @"time": item[@"time"], @"body": body };
}

static int cmdLink(NSString *addr) {
  IOBluetoothDevice *dev = [IOBluetoothDevice deviceWithAddressString:addr];
  if (!dev || !dev.isPaired) { emit(@{ @"ev": @"link", @"state": @"unpaired" }); return 2; }
  NSTimeInterval backoff = 3;
  for (;;) {
    emit(@{ @"ev": @"link", @"state": @"connecting" });
    MapLink *link = [MapLink new];
    link.dev = dev;
    NSString *fail = [link open];
    if (fail) {
      emit(@{ @"ev": @"link", @"state": fail });
      if ([fail isEqualToString:@"unsupported"]) return 3;
      spin(backoff, nil); backoff = MIN(backoff * 2, 30);
      continue;
    }
    backoff = 3;
    emit(@{ @"ev": @"link", @"state": @"connected", @"name": dev.name ?: @"" });

    NSMutableSet *seen = [NSMutableSet set];
    NSArray *first = [link listing:20];
    BOOL reported = NO;
    for (NSDictionary *it in first ?: @[]) {
      [seen addObject:it[@"handle"]];
      if (reported) continue;
      NSString *b = [link body:it[@"handle"]];
      if (b && looksLikeCode(b)) { emit(smsEvent(@"latest", it, b)); reported = YES; }
    }
    if (!reported) emit(@{ @"ev": @"latest", @"sms": [NSNull null] });

    while (link.alive) {
      spin(1.5, nil);
      NSArray *items = [link listing:5];
      if (!items) break;
      for (NSDictionary *it in items) {
        if ([seen containsObject:it[@"handle"]]) continue;
        [seen addObject:it[@"handle"]];
        NSString *b = [link body:it[@"handle"]];
        if (!b) break;
        if (looksLikeCode(b)) emit(smsEvent(@"sms", it, b));
      }
    }
    [link close];
    emit(@{ @"ev": @"link", @"state": @"lost" });
    spin(backoff, nil);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    exitOnStdinClose();
    NSString *cmd = argc > 1 ? @(argv[1]) : @"";
    if ([cmd isEqualToString:@"devices"]) return cmdDevices();
    if ([cmd isEqualToString:@"wait-pair"]) return cmdWaitPair();
    if ([cmd isEqualToString:@"link"] && argc > 2) return cmdLink(@(argv[2]));
    fprintf(stderr, "usage: career-phone-helper devices | wait-pair | link <address>\n");
    return 64;
  }
}
