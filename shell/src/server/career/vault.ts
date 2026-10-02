/**
 * 私密信息库单例（@career/core 的 Vault）。
 *
 * 密钥文件：`$CAREER_DATA_DIR/vault.key`（0600，与 SQLite 分开）；也可用环境变量 `CAREER_VAULT_KEY`（64 位 hex）。
 * 明文只在 Node 侧流转：填表 / 登录代填 / 导出简历 / UI 回显；工具层统一经 `redactForModel` 脱敏后才回传模型。
 */
import { join } from 'path';
import type { Repos, Vault } from '@career/core';
import { loadCore } from './core-module';
import { careerDataDir, getRepos } from './db';

let vault: Vault | null = null;
let opening: Promise<Vault> | null = null;

export function vaultKeyPath(): string {
  return join(careerDataDir(), 'vault.key');
}

/** 懒加载：与 getRepos 共用同一个 SQLite 连接。 */
export async function getVault(): Promise<Vault> {
  if (vault) return vault;
  if (!opening) {
    opening = Promise.all([loadCore(), getRepos()]).then(([core, repos]) => {
      vault = new core.Vault(repos.db, core.keyProviderFromEnv(vaultKeyPath()));
      return vault;
    }).finally(() => { opening = null; });
  }
  return opening;
}

/** 测试 / 关闭时注入或重置单例。 */
export function setVault(next: Vault | null): void {
  vault = next;
}

/** 给注入了自定义 Repos 的调用方（路由 / 工具测试）按同一连接构造 Vault。 */
export async function vaultForRepos(repos: Repos): Promise<Vault> {
  const core = await loadCore();
  return new core.Vault(repos.db, core.keyProviderFromEnv(vaultKeyPath()));
}
