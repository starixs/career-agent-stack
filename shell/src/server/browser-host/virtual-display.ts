/**
 * macOS 虚拟屏（可选，`CAREER_BROWSER_WINDOW=virtual-display`）：用私有 CGVirtualDisplay 建一块看不见的屏幕，
 * 托管 Chrome 只在这块屏上，不占用户桌面的角落；"显示真实窗口"时照旧搬回主屏。
 *
 * 2026-10-11 实测（真实 Chrome）：虚拟屏上画面流 3 秒 28 帧、截图 9–16ms、CDP 点击生效；
 * 虚拟屏放在主屏左上对角（只碰一个角、不共用边），鼠标按 macOS 规则过不去。
 * 风险：虚拟屏一消失，macOS 会把上面的窗口搬到主屏正中——所以和托管 Chrome 同生共死：
 * 先关 Chrome 再放屏；助手进程意外退出时 onLost 通知宿主立刻把窗口停回角落。
 * 私有 API 可能随系统升级失效：编译 / 创建失败一律退回角落停靠，不影响浏览器本身。
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const VIRTUAL_DISPLAY_SOURCE = String.raw`#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
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
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    unsigned int w = argc > 1 ? (unsigned int)atoi(argv[1]) : 1366;
    unsigned int h = argc > 2 ? (unsigned int)atoi(argv[2]) : 768;
    CGVirtualDisplayDescriptor *d = [[CGVirtualDisplayDescriptor alloc] init];
    d.queue = dispatch_get_main_queue();
    d.name = @"Career Agent Workspace";
    d.maxPixelsWide = w; d.maxPixelsHigh = h;
    d.sizeInMillimeters = CGSizeMake(w * 0.264, h * 0.264);
    d.productID = 0x4b53; d.vendorID = 0x4b53; d.serialNum = 1;
    d.terminationHandler = ^(id a, id b) { exit(0); };
    CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:d];
    if (!display) { printf("{\"error\":\"create failed\"}\n"); fflush(stdout); return 2; }
    CGVirtualDisplaySettings *s = [[CGVirtualDisplaySettings alloc] init];
    s.hiDPI = 0;
    s.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:w height:h refreshRate:60]];
    if (![display applySettings:s]) { printf("{\"error\":\"apply failed\"}\n"); fflush(stdout); return 3; }
    for (int i = 0; i < 50; i++) { if (CGDisplayBounds(display.displayID).size.width > 0) break; [NSThread sleepForTimeInterval:0.05]; }
    CGRect main = CGDisplayBounds(CGMainDisplayID());
    CGDisplayConfigRef cfg;
    if (CGBeginDisplayConfiguration(&cfg) == kCGErrorSuccess) {
      CGConfigureDisplayOrigin(cfg, display.displayID, (int)main.origin.x - (int)w, (int)main.origin.y - (int)h);
      CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
    }
    [NSThread sleepForTimeInterval:0.3];
    CGRect b = CGDisplayBounds(display.displayID);
    printf("{\"displayID\":%u,\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f}\n", display.displayID, b.origin.x, b.origin.y, b.size.width, b.size.height);
    fflush(stdout);
    dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(src, ^{ char buf[64]; if (read(STDIN_FILENO, buf, sizeof buf) <= 0) exit(0); });
    dispatch_resume(src);
    dispatch_main();
  }
}
`;

export interface VirtualDisplayBounds { displayID: number; x: number; y: number; w: number; h: number }

/** 解析助手进程第一行输出。 */
export function parseVirtualDisplayLine(line: string): VirtualDisplayBounds {
  const raw = JSON.parse(line) as Partial<VirtualDisplayBounds> & { error?: string };
  if (raw.error) throw new Error(`虚拟屏创建失败：${raw.error}`);
  if (![raw.displayID, raw.x, raw.y, raw.w, raw.h].every(v => typeof v === 'number') || !raw.w || !raw.h) throw new Error('虚拟屏返回的尺寸无效');
  return raw as VirtualDisplayBounds;
}

export interface VirtualDisplayOptions { binDir: string; width?: number; height?: number; clang?: string; onLost?: () => void; log?: (msg: string) => void }

export class VirtualDisplay {
  private child: ChildProcess | null = null;
  private bounds: VirtualDisplayBounds | null = null;
  private starting: Promise<VirtualDisplayBounds> | null = null;
  private stopping = false;
  constructor(private readonly opts: VirtualDisplayOptions) {}

  current(): VirtualDisplayBounds | null { return this.bounds; }

  private async binary(): Promise<string> {
    const dir = this.opts.binDir;
    mkdirSync(dir, { recursive: true });
    const tag = createHash('sha1').update(VIRTUAL_DISPLAY_SOURCE).digest('hex').slice(0, 10);
    const bin = join(dir, `career-vdisplay-${tag}`);
    if (existsSync(bin)) return bin;
    const src = `${bin}.m`;
    writeFileSync(src, VIRTUAL_DISPLAY_SOURCE);
    const clang = this.opts.clang ?? '/usr/bin/clang';
    if (!existsSync(clang)) throw new Error('没有 clang（需要 Xcode 命令行工具），退回角落停靠');
    await new Promise<void>((resolve, reject) => execFile(clang, ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', '-o', bin, src], { timeout: 120_000 }, e => (e ? reject(e) : resolve())));
    return bin;
  }

  /** 确保虚拟屏存在；返回它在全局坐标里的位置。 */
  ensure(): Promise<VirtualDisplayBounds> {
    if (this.bounds && this.child && this.child.exitCode === null) return Promise.resolve(this.bounds);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const bin = await this.binary();
      const child = spawn(bin, [String(this.opts.width ?? 1366), String(this.opts.height ?? 768)], { stdio: ['pipe', 'pipe', 'ignore'] });
      const bounds = await new Promise<VirtualDisplayBounds>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('虚拟屏创建超时')); }, 8000);
        child.stdout!.on('data', d => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          clearTimeout(timer);
          try { resolve(parseVirtualDisplayLine(buf.slice(0, nl))); } catch (e) { child.kill(); reject(e); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`虚拟屏助手退出（${code}）`)); });
      });
      this.child = child; this.bounds = bounds; this.stopping = false;
      child.once('exit', () => {
        const lost = !this.stopping;
        this.child = null; this.bounds = null;
        if (lost) { this.opts.log?.('虚拟屏意外消失，托管窗口退回角落'); this.opts.onLost?.(); }
      });
      this.opts.log?.(`虚拟屏就绪 id=${bounds.displayID} at ${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}`);
      return bounds;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** 释放虚拟屏：调用方必须先把托管窗口停走 / 关掉（否则 macOS 会把窗口搬到主屏正中）。 */
  stop(): void {
    this.stopping = true;
    const c = this.child;
    this.child = null; this.bounds = null;
    if (c) { c.stdin?.end(); setTimeout(() => { if (c.exitCode === null) c.kill(); }, 1500).unref?.(); }
  }
}

// ---------- 停靠目标（进程内唯一）：有虚拟屏时停到虚拟屏上，没有就退回角落 ----------
let parkTarget: { left: number; top: number; width: number; height: number } | null = null;
export function setVirtualParkTarget(bounds: VirtualDisplayBounds | null): void {
  parkTarget = bounds ? { left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h } : null;
}
export function virtualParkTarget(): { left: number; top: number; width: number; height: number } | null { return parkTarget; }
