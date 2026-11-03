import { describe, expect, it } from 'vitest';

import { StaticKeyProvider, Vault } from '@career/core';

import { createMemoryRepos } from '../test-db';
import { applyAddress, connectorForAddress, reconcileApplyAddress } from './apply-address';

const vaultOf = () => new Vault(createMemoryRepos().db, new StaticKeyProvider(Buffer.alloc(32, 9)));

describe('邮箱和投递打通：网申用的邮箱', () => {
  it('按域名认出该连哪家；认不出的不猜', () => {
    expect(connectorForAddress('Me@Foxmail.com')).toBe('qq');
    expect(connectorForAddress('a@163.com')).toBe('163');
    expect(connectorForAddress('a@school.edu.cn')).toBeNull();
  });

  it('基本资料里没填邮箱：连上的这个记进去，之后网申就填它', () => {
    const vault = vaultOf();
    expect(applyAddress(vault)).toBeNull();
    expect(reconcileApplyAddress(vault, 'me@qq.com')).toBeNull();
    expect(applyAddress(vault)).toEqual({ address: 'me@qq.com', connector_id: 'qq' });
  });

  it('填的是另一个：不改他的资料，返回网申用的那个让界面说一句；同一个（大小写不同）不说', () => {
    const vault = vaultOf();
    vault.set({ scope: 'profile', field: 'email', value: 'apply@163.com' });
    expect(reconcileApplyAddress(vault, 'other@qq.com')).toBe('apply@163.com');
    expect(applyAddress(vault)?.address).toBe('apply@163.com');
    expect(reconcileApplyAddress(vault, 'Apply@163.com')).toBeNull();
  });
});
