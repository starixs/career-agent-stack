import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StructuredJson } from './CareerPrimitives';
import { briefText, structuredKeyLabel } from './structuredLabels';

describe('技能 JSON 在页面上不露英文键和原始 JSON', () => {
  it('认得的键换中文，枚举值换中文', () => {
    render(<StructuredJson value={{ focus_this_round: '项目深挖', session: { result: 'advanced', track: 'campus' } }} />);
    expect(screen.getByText('这一轮的重点')).toBeInTheDocument();
    expect(screen.getByText('进入下一轮')).toBeInTheDocument();
    expect(screen.getByText('校招')).toBeInTheDocument();
    expect(screen.queryByText('focus_this_round')).toBeNull();
  });

  it('不认得的英文键：对象略过，单个文字归到「其他」；内部 id 不显示', () => {
    const { container } = render(<StructuredJson value={{ weird_nested: { a: 1 }, odd_note: '留意薪资', claim_id: 'c_123' }} />);
    expect(screen.getByText('其他')).toBeInTheDocument();
    expect(screen.getByText('留意薪资')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/weird_nested|odd_note|c_123|\{/);
  });

  it('briefText：对象取文字连成一句，取不到返回 null', () => {
    expect(briefText({ requirement: 'K8s', evidence: '做过集群迁移', claim_id: 'x' })).toBe('K8s：做过集群迁移');
    expect(briefText({ n: 1 })).toBeNull();
    expect(structuredKeyLabel('unknown_key')).toBeNull();
    expect(structuredKeyLabel('中文键')).toBe('中文键');
  });
});
