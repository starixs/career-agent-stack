// career-window-helper：托管 Chrome 的 macOS 原生窗口助手。由 browser-host 启动，stdin 关闭即退出；
// 输出一行一个 JSON 事件（{"ev": ...}）。构建期由 scripts/prepare-window-helper.mjs 预编译进安装包。
//
// display <w> <h>：建一块看不见的虚拟屏（私有 CGVirtualDisplay）。放在哪由宿主决定（放置算法在 TS 里，可测）：
//   助手上报所有屏幕（"displays"），宿主回 "place <x> <y>"，助手放好后上报实际结果（"placed"）。
//   屏幕配置变化（插拔 / 调整排列）时再报一次 "displays"，宿主核对是否还和别的屏共用边。
// guard：按 --user-data-dir 认领托管 Chrome。被系统激活（开新页 / 弹窗 / 启动）时把焦点还给之前的应用；
//   hidden 模式下保持隐藏（隐藏状态下 DOM 照常运行，画面由宿主用 fromSurface:false 截图拿）。
//   命令：expect <0|1> <dir> / hidden <0|1> <dir> / pause <0|1> <dir> / forget <dir> / probe <dir>
//   （dir 是行尾剩余部分，可含空格）。probe 只读：报托管 Chrome 是否隐藏、当前前台应用（排障 / 冒烟用）。
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <sys/sysctl.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property (retain, nonatomic) dispatch_queue_t queue;
@property (retain, nonatomic) NSString *name;
@property (nonatomic) unsigned int maxPixelsWide;
@property (nonatomic) unsigned int maxPixelsHigh;
@property (nonatomic) CGSize sizeInMillimeters;
@property (nonatomic) unsigned int productID;
@property (nonatomic) unsigned int vendorID;
@property (nonatomic) unsigned int serialNum;
@property (copy, nonatomic) void (^terminationHandler)(id, id);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property (retain, nonatomic) NSArray *modes;
@property (nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
@property (readonly, nonatomic) unsigned int displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

static void emit(NSDictionary *obj) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!data) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

// stdin 按行分发；EOF = 宿主走了，跟着退出。全局持有事件源，防止 ARC 释放。
static dispatch_source_t gStdinSource;
static void readLines(void (^handle)(NSString *line)) {
  static NSMutableData *pending;
  pending = [NSMutableData data];
  dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(src, ^{
    char buf[4096];
    ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
    if (n <= 0) exit(0);
    [pending appendBytes:buf length:(NSUInteger)n];
    for (;;) {
      NSRange nl = [pending rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, pending.length)];
      if (nl.location == NSNotFound) break;
      NSString *line = [[NSString alloc] initWithData:[pending subdataWithRange:NSMakeRange(0, nl.location)] encoding:NSUTF8StringEncoding];
      [pending replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
      if (line.length) handle(line);
    }
  });
  dispatch_resume(src);
  gStdinSource = src;
}

// ---------------- display ----------------

static CGVirtualDisplay *gDisplay;

static NSArray *displayList(void) {
  uint32_t count = 0;
  CGGetActiveDisplayList(0, NULL, &count);
  CGDirectDisplayID ids[32];
  if (count > 32) count = 32;
  CGGetActiveDisplayList(count, ids, &count);
  NSMutableArray *list = [NSMutableArray array];
  for (uint32_t i = 0; i < count; i++) {
    CGRect b = CGDisplayBounds(ids[i]);
    [list addObject:@{ @"id": @(ids[i]), @"x": @(b.origin.x), @"y": @(b.origin.y), @"w": @(b.size.width), @"h": @(b.size.height), @"main": @(CGDisplayIsMain(ids[i]) != 0) }];
  }
  return list;
}

static void reportDisplays(NSString *ev) {
  emit(@{ @"ev": ev, @"self": @(gDisplay.displayID), @"displays": displayList() });
}

static void onReconfigure(CGDirectDisplayID display, CGDisplayChangeSummaryFlags flags, void *info) {
  if (flags & kCGDisplayBeginConfigurationFlag) return;
  // 一次重排会对每块屏各回调一次：合并成一次上报
  static BOOL scheduled = NO;
  if (scheduled) return;
  scheduled = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    scheduled = NO;
    reportDisplays(@"displays");
  });
}

static int runDisplay(unsigned int w, unsigned int h) {
  CGVirtualDisplayDescriptor *d = [[CGVirtualDisplayDescriptor alloc] init];
  d.queue = dispatch_get_main_queue();
  d.name = @"Career Agent Workspace";
  d.maxPixelsWide = w; d.maxPixelsHigh = h;
  d.sizeInMillimeters = CGSizeMake(w * 0.264, h * 0.264);
  d.productID = 0x4b53; d.vendorID = 0x4b53; d.serialNum = 1;
  d.terminationHandler = ^(id a, id b) { exit(0); };
  gDisplay = [[CGVirtualDisplay alloc] initWithDescriptor:d];
  if (!gDisplay) { emit(@{ @"ev": @"error", @"error": @"create failed" }); return 2; }
  CGVirtualDisplaySettings *s = [[CGVirtualDisplaySettings alloc] init];
  s.hiDPI = 0;
  s.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:w height:h refreshRate:60]];
  if (![gDisplay applySettings:s]) { emit(@{ @"ev": @"error", @"error": @"apply failed" }); return 3; }
  for (int i = 0; i < 50; i++) { if (CGDisplayBounds(gDisplay.displayID).size.width > 0) break; [NSThread sleepForTimeInterval:0.05]; }
  CGDisplayRegisterReconfigurationCallback(onReconfigure, NULL);
  reportDisplays(@"displays");
  readLines(^(NSString *line) {
    int x = 0, y = 0;
    if (sscanf(line.UTF8String, "place %d %d", &x, &y) != 2) return;
    CGDisplayConfigRef cfg;
    if (CGBeginDisplayConfiguration(&cfg) == kCGErrorSuccess) {
      CGConfigureDisplayOrigin(cfg, gDisplay.displayID, x, y);
      CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
    }
    [NSThread sleepForTimeInterval:0.3];
    reportDisplays(@"placed");
  });
  dispatch_main();
}

// ---------------- guard ----------------

@interface Managed : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic) BOOL hidden;
@property (nonatomic) BOOL paused;
@end
@implementation Managed
@end

static NSMutableDictionary<NSString *, Managed *> *gManaged;
static NSRunningApplication *gLastOther;

static BOOL processHasArg(pid_t pid, const char *needle) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size == 0) return NO;
  char *buf = malloc(size);
  if (!buf) return NO;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0) { free(buf); return NO; }
  int argc = *(int *)buf;
  char *p = buf + sizeof(int), *end = buf + size;
  p += strnlen(p, (size_t)(end - p));  // 可执行文件路径
  while (p < end && *p == 0) p++;
  BOOL hit = NO;
  for (int i = 0; i < argc && p < end; i++) {
    if (strcmp(p, needle) == 0) { hit = YES; break; }
    p += strnlen(p, (size_t)(end - p)) + 1;
  }
  free(buf);
  return hit;
}

/** 这个应用是不是托管 Chrome 的主进程：先按已认领的 pid，再按启动参数认领。 */
static Managed *managedFor(NSRunningApplication *app) {
  pid_t pid = app.processIdentifier;
  for (Managed *m in gManaged.allValues) if (m.pid == pid) return m;
  for (NSString *dir in gManaged) {
    Managed *m = gManaged[dir];
    if (m.pid != 0) continue;
    if (!processHasArg(pid, [@"--user-data-dir=" stringByAppendingString:dir].UTF8String)) continue;
    m.pid = pid;
    emit(@{ @"ev": @"adopted", @"dir": dir, @"pid": @(pid) });
    return m;
  }
  return nil;
}

static void applyHidden(Managed *m) {
  if (!m.pid) return;
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:m.pid];
  if (!app) return;
  if (m.hidden && !m.paused && !app.hidden) [app hide];
  if ((!m.hidden || m.paused) && app.hidden) [app unhide];
}

static void restoreFocus(void) {
  if (!gLastOther || gLastOther.terminated) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [gLastOther activateWithOptions:0];
#pragma clang diagnostic pop
}

static int runGuard(void) {
  [NSApplication sharedApplication];
  // 不要 Dock 图标、不要菜单栏；hide/unhide 别的应用需要先成为一个 NSApplication
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  gManaged = [NSMutableDictionary dictionary];
  NSWorkspace *ws = [NSWorkspace sharedWorkspace];
  NSRunningApplication *front = ws.frontmostApplication;
  if (front && front.processIdentifier != getpid()) gLastOther = front;
  NSNotificationCenter *nc = ws.notificationCenter;
  NSOperationQueue *main = [NSOperationQueue mainQueue];
  [nc addObserverForName:NSWorkspaceDidLaunchApplicationNotification object:nil queue:main usingBlock:^(NSNotification *n) {
    Managed *m = managedFor(n.userInfo[NSWorkspaceApplicationKey]);
    if (m) applyHidden(m);
  }];
  [nc addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:main usingBlock:^(NSNotification *n) {
    NSRunningApplication *app = n.userInfo[NSWorkspaceApplicationKey];
    Managed *m = managedFor(app);
    if (!m) { gLastOther = app; return; }
    if (m.paused) return;  // 用户临时放出了真实窗口：由用户操作
    restoreFocus();
    if (m.hidden) [app hide];
    emit(@{ @"ev": @"refocused", @"pid": @(m.pid), @"to": @(gLastOther.processIdentifier) });
  }];
  [nc addObserverForName:NSWorkspaceDidUnhideApplicationNotification object:nil queue:main usingBlock:^(NSNotification *n) {
    Managed *m = managedFor(n.userInfo[NSWorkspaceApplicationKey]);
    if (m && m.hidden && !m.paused) [(NSRunningApplication *)n.userInfo[NSWorkspaceApplicationKey] hide];
  }];
  [nc addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil queue:main usingBlock:^(NSNotification *n) {
    pid_t pid = ((NSRunningApplication *)n.userInfo[NSWorkspaceApplicationKey]).processIdentifier;
    for (NSString *dir in gManaged) if (gManaged[dir].pid == pid) { gManaged[dir].pid = 0; emit(@{ @"ev": @"exited", @"dir": dir }); }
  }];
  readLines(^(NSString *line) {
    NSArray<NSString *> *parts = [line componentsSeparatedByString:@" "];
    NSString *cmd = parts.firstObject;
    if ([cmd isEqualToString:@"probe"] && parts.count >= 2) {
      NSString *dir = [[parts subarrayWithRange:NSMakeRange(1, parts.count - 1)] componentsJoinedByString:@" "];
      Managed *m = gManaged[dir];
      NSRunningApplication *app = m.pid ? [NSRunningApplication runningApplicationWithProcessIdentifier:m.pid] : nil;
      emit(@{ @"ev": @"probe", @"dir": dir, @"pid": @(m.pid), @"hidden": @(app.hidden), @"front": @(ws.frontmostApplication.processIdentifier) });
      return;
    }
    if ([cmd isEqualToString:@"forget"] && parts.count >= 2) {
      [gManaged removeObjectForKey:[[parts subarrayWithRange:NSMakeRange(1, parts.count - 1)] componentsJoinedByString:@" "]];
      return;
    }
    if (parts.count < 3) return;
    BOOL on = [parts[1] isEqualToString:@"1"];
    NSString *dir = [[parts subarrayWithRange:NSMakeRange(2, parts.count - 2)] componentsJoinedByString:@" "];
    Managed *m = gManaged[dir];
    if ([cmd isEqualToString:@"expect"]) {
      if (!m) { m = [Managed new]; gManaged[dir] = m; }
      m.hidden = on;
      // 助手重启时托管 Chrome 可能早已在运行：立即按参数认领
      if (!m.pid) for (NSRunningApplication *app in ws.runningApplications) if (managedFor(app) == m) break;
      applyHidden(m);
    } else if ([cmd isEqualToString:@"hidden"] && m) {
      m.hidden = on;
      applyHidden(m);
    } else if ([cmd isEqualToString:@"pause"] && m) {
      m.paused = on;
      applyHidden(m);
    }
  });
  emit(@{ @"ev": @"ready" });
  [[NSRunLoop mainRunLoop] run];
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc >= 4 && strcmp(argv[1], "display") == 0) return runDisplay((unsigned int)atoi(argv[2]), (unsigned int)atoi(argv[3]));
    if (argc >= 2 && strcmp(argv[1], "guard") == 0) return runGuard();
    fprintf(stderr, "usage: career-window-helper display <w> <h> | guard\n");
    return 64;
  }
}
