/**
 * `@career/core` 的惰性加载器。
 *
 * 为什么不直接 `import { … } from '@career/core'`：esbuild 单文件 bundle 会把所有外部包的静态
 * import 提升到 bundle 顶层，于是没有 staged 领域库的发布版 Sidecar 在启动时就会
 * ERR_MODULE_NOT_FOUND（见 scripts/server-bundle-browser-host.test.mjs 的"裸发布包必须能
 * 回答 /health"契约）。所有运行期用到 core 的地方都经由这里 `await loadCore()`；
 * 类型用 `import type` 即可（会被擦除）。
 */
export type CoreModule = typeof import('@career/core');

let cached: Promise<CoreModule> | null = null;

export class CoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(`求职数据层 @career/core 尚未就绪：${cause instanceof Error ? cause.message : String(cause ?? '未安装或未构建')}`);
    this.name = 'CoreUnavailableError';
  }
}

export function loadCore(): Promise<CoreModule> {
  if (!cached) {
    cached = import('@career/core').catch((error: unknown) => {
      cached = null;
      throw new CoreUnavailableError(error);
    });
  }
  return cached;
}

/** 测试注入。 */
export function setCoreModule(mod: CoreModule | null): void {
  cached = mod ? Promise.resolve(mod) : null;
}
