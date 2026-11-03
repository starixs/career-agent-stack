/**
 * 邮箱和投递打通：网申表里填的是基本资料里的邮箱（vault profile.email），招聘方的回音只会发到那里。
 * - 连邮箱时按它预填地址、默认选对应的服务商：用户不用再打一遍，也不会连成另一个收不到回音的邮箱；
 * - 连上的邮箱和它对不上时如实说一句；基本资料里还没有邮箱时，把连上的这个记进去，之后网申就填它。
 * 地址是用户自己的，只给他自己的界面看，不进模型上下文。
 */
import type { Vault } from '@career/core';

import type { ConnectorId } from './connectors';

const PROFILE_EMAIL = { scope: 'profile' as const, field: 'email' };

/** 邮箱域名 → 连接器。foxmail 走 QQ 邮箱的服务器。 */
const DOMAIN_CONNECTOR: Record<string, ConnectorId> = { 'qq.com': 'qq', 'foxmail.com': 'qq', '163.com': '163', '126.com': '126', 'gmail.com': 'gmail', 'googlemail.com': 'gmail' };

export interface ApplyAddress { address: string; connector_id: ConnectorId | null }

export function connectorForAddress(address: string): ConnectorId | null {
  return DOMAIN_CONNECTOR[address.trim().toLowerCase().split('@')[1] ?? ''] ?? null;
}

/** 网申用的邮箱（没填返回 null）。 */
export function applyAddress(vault: Vault): ApplyAddress | null {
  const address = vault.reveal(PROFILE_EMAIL, { actor: 'ui', purpose: '连邮箱时预填网申用的邮箱' })?.trim();
  return address ? { address, connector_id: connectorForAddress(address) } : null;
}

/**
 * 连上一个邮箱之后：基本资料里没有邮箱就记成它；有且不同，返回网申用的那个（界面说一句），相同返回 null。
 */
export function reconcileApplyAddress(vault: Vault, connected: string): string | null {
  const current = applyAddress(vault)?.address;
  if (!current) {
    vault.set({ ...PROFILE_EMAIL, value: connected, label: '邮箱' });
    return null;
  }
  return current.toLowerCase() === connected.trim().toLowerCase() ? null : current;
}
