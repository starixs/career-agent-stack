import { describe, expect, it } from 'vitest';

import { askShapeDenial, readScopeDenial } from './tool-guards';

const ws = '/Users/x/.keystone/projects/career';

describe('readScopeDenial', () => {
  it('allows attachment text and images inside the workspace (relative or absolute)', () => {
    expect(readScopeDenial('Read', { file_path: 'keystone_files/.converted/cv.pdf.md' }, ws)).toBeNull();
    expect(readScopeDenial('Read', { file_path: `${ws}/keystone_files/photo.png` }, ws)).toBeNull();
  });

  it('denies local logs, config and other projects', () => {
    expect(readScopeDenial('Read', { file_path: '/Users/x/.keystone/logs/unified-2026-11-04.log' }, ws)).toContain('工作区');
    expect(readScopeDenial('Read', { file_path: '../../config.json' }, ws)).toContain('工作区');
    expect(readScopeDenial('Read', { file_path: '/Users/x/.keystone/projects/career-other/a.md' }, ws)).toContain('工作区');
  });

  it('ignores other tools and malformed input', () => {
    expect(readScopeDenial('Skill', { file_path: '/etc/passwd' }, ws)).toBeNull();
    expect(readScopeDenial('Read', {}, ws)).toBeNull();
    expect(readScopeDenial('Read', { file_path: '/etc/passwd' }, undefined)).toBeNull();
  });
});

describe('askShapeDenial', () => {
  const option = (label: string) => ({ label, description: '' });

  it('allows one question with up to three options', () => {
    expect(askShapeDenial('AskUserQuestion', { questions: [{ question: '先投哪批？', options: [option('A'), option('B'), option('C')] }] })).toBeNull();
  });

  it('sends a multi-question survey back to be cut down to one', () => {
    const input = { questions: [{ question: 'q1', options: [option('a'), option('b')] }, { question: 'q2', options: [option('a'), option('b')] }] };
    expect(askShapeDenial('AskUserQuestion', input)).toContain('一次只问一件事');
  });

  it('sends four options back to be cut to three', () => {
    const input = { questions: [{ question: 'q', options: [option('a'), option('b'), option('c'), option('d')] }] };
    expect(askShapeDenial('AskUserQuestion', input)).toContain('最多 3 个');
  });

  it('ignores other tools', () => {
    expect(askShapeDenial('Read', { questions: [1, 2, 3] })).toBeNull();
  });
});
