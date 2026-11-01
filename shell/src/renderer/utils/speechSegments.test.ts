import { describe, expect, it } from 'vitest';

import { splitSpeechSegments } from './speechSegments';

describe('splitSpeechSegments', () => {
  it('splits plain paragraphs into separate blocks', () => {
    expect(splitSpeechSegments('收到。\n\n你简历里写的是 2023.09 入学。\n\n用哪个？')).toEqual([
      '收到。',
      '你简历里写的是 2023.09 入学。',
      '用哪个？',
    ]);
  });

  it('keeps a list together with the line that introduces it when items are separated by blank lines', () => {
    expect(splitSpeechSegments('- 财务分析\n\n- 运营助理\n\n行吗？')).toEqual(['- 财务分析\n\n- 运营助理', '行吗？']);
  });

  it('never splits inside a code fence', () => {
    const text = '看这段：\n\n```\na\n\nb\n```';
    expect(splitSpeechSegments(text)).toEqual(['看这段：', '```\na\n\nb\n```']);
  });

  it('keeps a heading with the paragraph after it', () => {
    expect(splitSpeechSegments('## 今天\n\n投出 3 家。')).toEqual(['## 今天\n\n投出 3 家。']);
  });

  it('returns nothing for blank text', () => {
    expect(splitSpeechSegments('\n\n  \n')).toEqual([]);
  });
});
