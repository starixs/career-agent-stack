import type { Claim } from '@career/core';
import { describe, expect, it } from 'vitest';

import { guardTailorOps, unsupportedTokens } from './tailor-guard';

const claim = (id: string, experience_id: string, text: string): Claim => ({ id, experience_id, text, attribution: 'self', result_metric: null, status: 'user_confirmed', created_from: 'doc', created_at: '', updated_at: '' });
const CLAIMS = [claim('a1', 'expA', '订单导出改成后台排队分批生成，用 RocketMQ'), claim('b1', 'expB', '用大模型对客服对话分类打标，Python 脚本')];
const MASTER = {
  experience: [
    { org: '杭州某电商', position: '后端实习', bullets: ['订单导出改成后台排队分批生成'], claim_ids: ['a1'] },
    { org: '实验室合作公司', position: '算法实习', bullets: ['客服对话分类打标'], claim_ids: ['b1'] },
  ],
};

describe('定制防编造闸门', () => {
  it('10-30 实测的串位：把第二段实习整条换成第一段的机构和内容 → 拦下', () => {
    const { ops, blocked } = guardTailorOps(MASTER, [{ op: 'replace', path: '/experience/1', value: { ...MASTER.experience[0] } }], [], CLAIMS);
    expect(ops).toEqual([]);
    expect(blocked[0].why).toContain('机构 / 时间对不上');
  });

  it('把别的经历才有的术语写进这一条 → 拦下；本条依据里有的 → 放行', () => {
    const out = guardTailorOps(MASTER, [
      { op: 'replace', path: '/experience/1/bullets/0', value: '用 RocketMQ 做客服对话分类' },
      { op: 'replace', path: '/experience/1/bullets/0', value: '用 Python 脚本完成客服对话分类打标' },
    ], [], CLAIMS);
    expect(out.blocked.map(b => b.why)).toEqual(['出现了没有依据的内容：RocketMQ']);
    expect(out.ops).toHaveLength(1);
  });

  it('删除、调顺序、改求职意向放行', () => {
    const { ops } = guardTailorOps(MASTER, [{ op: 'remove', path: '/experience/1' }, { op: 'replace', path: '/section_order', value: ['experience'] }, { op: 'replace', path: '/basics/objective', value: '后端开发' }], [], CLAIMS);
    expect(ops).toHaveLength(3);
  });

  it('数字和英文术语按不区分大小写比对', () => {
    expect(unsupportedTokens('Redis 缓存命中 95%', 'redis 命中率 95%')).toEqual([]);
    expect(unsupportedTokens('QPS 提升 30%', '性能提升')).toEqual(['30%', 'QPS']);
  });
});
