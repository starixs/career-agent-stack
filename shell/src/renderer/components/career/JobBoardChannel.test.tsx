/**
 * 岗位库「投递方式」那一格（R5）：只收邮件的岗位没有网申链接，显示「邮件投递」签，不出空链接、不报错。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApplyChannelCell } from './JobBoard';

describe('投递方式那一格', () => {
  it('只有投递邮箱、url 为空：「邮件投递」签，没有链接', () => {
    const { container } = render(<ApplyChannelCell job={{ url: null, apply_email: 'hr@x.cn' }} />);
    expect(screen.getByText('邮件投递')).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('有网申链接：「网申」链接；两样都没有：一个短横', () => {
    render(<ApplyChannelCell job={{ url: 'https://x.cn/apply', apply_email: null }} />);
    expect(screen.getByRole('link', { name: /网申/ })).toHaveAttribute('href', 'https://x.cn/apply');
    const { container } = render(<ApplyChannelCell job={{ url: null, apply_email: null }} />);
    expect(container.querySelector('a')).toBeNull();
  });
});
