import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";

import type { createConnection } from "@playwright/mcp";
import type { BrowserContextOptions, LaunchOptions } from "playwright";

export type PlaywrightConnectionConfig = NonNullable<
  Parameters<typeof createConnection>[0]
>;

export type BrowserChannel = "chrome" | "managed-chromium";

/**
 * 产品级浏览器策略（"像真人用自己的浏览器"）。全部由环境变量 / 本机状态推导，
 * 用户端没有设置项：
 * - `CAREER_BROWSER_PERSISTENT=0`：回退到旧的"共享 Chromium + 隔离 Context + identity-store 保存 Cookie"。
 * - `CAREER_BROWSER_CHANNEL=chrome|chromium`：强制使用本机 Chrome / 托管 Chromium；缺省自动探测。
 * - `CAREER_BROWSER_IDENTITY_MIRROR=1`：持久 profile 模式下仍把 Cookie 旁路镜像到 identity-store（失败只记日志）。
 */
export interface BrowserRuntimePolicy {
  persistentProfile: boolean;
  systemChrome: boolean;
  mirrorIdentity: boolean;
  /** 持久 profile 根目录（每个 Product Session 一个子目录）。 */
  profileRoot: string;
  /**
   * 内嵌窗口：真实 Chrome 仍是 headed（反检测），但窗口停在屏幕角落几乎不可见，
   * 用户只在产品内的现场画面里看 / 操作。`CAREER_BROWSER_WINDOW=window` 退回独立窗口。
   */
  embeddedWindow?: boolean;
}

export interface CompiledBrowserRuntimeSettings {
  browserName: "chromium";
  channel: BrowserChannel;
  /** 持久 profile 目录；隔离模式下为 null。 */
  userDataDir: string | null;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  /** 每个 Page 启动前注入，抹平自动化痕迹。 */
  initScript: string;
  connectionConfig: PlaywrightConnectionConfig;
}

/** 去自动化标志。不做 UA 伪造、不绕验证码、不换代理、不做多账号。 */
export const HUMAN_LIKE_CHROMIUM_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  // 托管浏览器的页面由产品恢复；Chrome 自己的"未正确关闭 / 恢复页面"气泡只会让用户以为浏览器崩了
  "--hide-crash-restore-bubble",
];

/**
 * 内嵌窗口模式的额外参数：窗口被遮挡 / 停在屏幕外时 Chrome 默认会暂停绘制，
 * 截图、screencast、计时器都会卡住，必须关掉这三种节流。初始窗口尽量靠外，但要装得下页面视口（窗口比视口小时 screencast 按窗口尺寸出帧，画面比例会错），
 * 启动后 Registry 再用 CDP 把每个窗口停到角落（macOS 会把位置夹回屏幕内，只露出一小角）。
 * 不用最小化 / 隐藏应用：实测这两种状态下 Page.captureScreenshot 会一直挂住。
 */
export const EMBEDDED_WINDOW_CHROMIUM_ARGS: readonly string[] = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--window-size=1440,1000",
  "--window-position=-10000,10000",
];

export const IGNORED_DEFAULT_CHROMIUM_ARGS: readonly string[] = ["--enable-automation"];

export const HUMAN_LIKE_CONTEXT_OPTIONS: Readonly<BrowserContextOptions> = {
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  viewport: { width: 1366, height: 768 },
};

/**
 * 真实 Chrome 配合 `--disable-blink-features=AutomationControlled` 本身已不暴露
 * `navigator.webdriver`；这里只补齐被 Playwright 空 profile 抹掉的"普通用户"特征。
 */
export const HUMAN_LIKE_INIT_SCRIPT = `(() => {
  const define = (target, key, value) => {
    try { Object.defineProperty(target, key, { get: () => value, configurable: true }); } catch {}
  };
  if (navigator.webdriver !== false) define(navigator, 'webdriver', false);
  define(navigator, 'languages', ['zh-CN', 'zh']);
  if (!navigator.plugins || navigator.plugins.length === 0) {
    const plugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    ];
    plugins.item = index => plugins[index] ?? null;
    plugins.namedItem = name => plugins.find(plugin => plugin.name === name) ?? null;
    plugins.refresh = () => {};
    define(navigator, 'plugins', plugins);
  }
  if (!window.chrome) {
    try {
      window.chrome = { app: { isInstalled: false }, runtime: {}, loadTimes() { return {}; }, csi() { return {}; } };
    } catch {}
  }
})();`;

function systemChromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => typeof root === "string" && root.length > 0,
    );
    return roots.map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ];
}

export function detectSystemChrome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): boolean {
  return systemChromeCandidates(platform, env, home).some(candidate => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
}

export function resolveBrowserRuntimePolicy(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): BrowserRuntimePolicy {
  const channel = env.CAREER_BROWSER_CHANNEL?.trim().toLowerCase();
  return {
    persistentProfile: env.CAREER_BROWSER_PERSISTENT?.trim() !== "0",
    systemChrome: channel === "chrome"
      ? true
      : channel === "chromium"
        ? false
        : detectSystemChrome(platform, env, home),
    mirrorIdentity: env.CAREER_BROWSER_IDENTITY_MIRROR?.trim() === "1",
    profileRoot: join(home, ".keystone", "browser-profile"),
    embeddedWindow: env.CAREER_BROWSER_WINDOW?.trim().toLowerCase() !== "window",
  };
}

function safeSessionSegment(productSessionId: string): string {
  return productSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "session";
}

function assertArtifactRoot(
  workspacePath: string,
  productSessionId: string,
): string {
  const canonicalizeExistingPrefix = (path: string): string => {
    const suffix: string[] = [];
    let cursor = resolve(path);
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    return resolve(realpathSync(cursor), ...suffix);
  };
  const workspace = canonicalizeExistingPrefix(workspacePath);
  const output = canonicalizeExistingPrefix(
    resolve(
      workspace,
      ".keystone",
      "browser-artifacts",
      safeSessionSegment(productSessionId),
    ),
  );
  const relativeOutput = relative(workspace, output);
  if (
    relativeOutput === ".." ||
    relativeOutput.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(relativeOutput)
  ) {
    throw new Error("BROWSER_ARTIFACT_ROOT_INVALID");
  }
  return output;
}

/**
 * keystone 托管浏览器的产品契约：headed 的真实 Chrome（没有则托管 Chromium）、
 * 去自动化标志、中文桌面环境、每 Product Session 一个持久 profile。
 * 标准 Playwright argv 属于独立的 `playwright` preset，不在这里编译。
 */
export function compileBrowserRuntimeSettings(
  productSessionId: string,
  workspacePath: string,
  policy: BrowserRuntimePolicy = resolveBrowserRuntimePolicy(),
): CompiledBrowserRuntimeSettings {
  const channel: BrowserChannel = policy.systemChrome ? "chrome" : "managed-chromium";
  const launchOptions: LaunchOptions = {
    headless: false,
    // Global Sidecar drains tools and checkpoints live Contexts before closing
    // Chromium. Playwright's parallel signal handlers would preempt that owner.
    handleSIGINT: false,
    handleSIGTERM: false,
    // 本机 Chrome 由 Playwright 按 channel 自己定位；托管 Chromium 的
    // executablePath 由 Registry 在解析完 Rust 资源后再补上。
    ...(channel === "chrome" ? { channel: "chrome" } : {}),
    args: [...HUMAN_LIKE_CHROMIUM_ARGS, ...(policy.embeddedWindow ? EMBEDDED_WINDOW_CHROMIUM_ARGS : [])],
    ignoreDefaultArgs: [...IGNORED_DEFAULT_CHROMIUM_ARGS],
  };
  const contextOptions: BrowserContextOptions = {
    ...HUMAN_LIKE_CONTEXT_OPTIONS,
    viewport: HUMAN_LIKE_CONTEXT_OPTIONS.viewport
      ? { ...HUMAN_LIKE_CONTEXT_OPTIONS.viewport }
      : undefined,
  };
  const connectionConfig: PlaywrightConnectionConfig = {
    capabilities: ["storage"],
    allowUnrestrictedFileAccess: false,
    outputDir: assertArtifactRoot(workspacePath, productSessionId),
    outputMode: "stdout",
    browser: {
      browserName: "chromium",
      isolated: !policy.persistentProfile,
      launchOptions,
      contextOptions,
    },
  };
  return {
    browserName: "chromium",
    channel,
    userDataDir: policy.persistentProfile
      ? join(policy.profileRoot, safeSessionSegment(productSessionId))
      : null,
    launchOptions,
    contextOptions,
    initScript: HUMAN_LIKE_INIT_SCRIPT,
    connectionConfig,
  };
}
