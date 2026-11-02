/**
 * 求职领域库的惰性加载器。
 *
 * `@career/resume`（react-pdf / canvas）、`@career/bridges`（Python 桥）、`@career/apply`
 * （playwright-core）都比较重且可能尚未构建；这里用动态 import 包一层，未就绪时抛
 * `DomainUnavailableError`（路由层映射为 501，工具层映射为 isError 文本），不阻塞其他能力。
 */
export class DomainUnavailableError extends Error {
  constructor(pkg: string, cause?: unknown) {
    super(`领域库 ${pkg} 尚未就绪：${cause instanceof Error ? cause.message : String(cause ?? '未安装或未构建')}`);
    this.name = 'DomainUnavailableError';
  }
}

type ResumeModule = typeof import('@career/resume');
type BridgesModule = typeof import('@career/bridges');
type ApplyModule = typeof import('@career/apply');

const cache = new Map<string, Promise<unknown>>();

async function load<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  let p = cache.get(pkg) as Promise<T> | undefined;
  if (!p) {
    p = importer().catch((error: unknown) => {
      cache.delete(pkg);
      throw new DomainUnavailableError(pkg, error);
    });
    cache.set(pkg, p);
  }
  return p;
}

export function loadResume(): Promise<ResumeModule> {
  return load('@career/resume', () => import('@career/resume'));
}

export function loadBridges(): Promise<BridgesModule> {
  return load('@career/bridges', () => import('@career/bridges'));
}

let loadedApplyModule: ApplyModule | null = null;

export function loadApply(): Promise<ApplyModule> {
  return load('@career/apply', () => import('@career/apply')).then(mod => { loadedApplyModule = mod; return mod; });
}

/** 已经加载过的 @career/apply（同步取用，比如提交决策当下要认网申系统）；还没加载过就是 null。 */
export function loadedApply(): ApplyModule | null {
  return loadedApplyModule;
}

/** 测试注入。 */
export function setDomainModule(pkg: '@career/resume' | '@career/bridges' | '@career/apply', mod: unknown | null): void {
  if (mod === null) cache.delete(pkg);
  else cache.set(pkg, Promise.resolve(mod));
  if (pkg === '@career/apply') loadedApplyModule = (mod as ApplyModule | null) ?? null;
}
