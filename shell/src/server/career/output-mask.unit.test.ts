import { describe, expect, it } from 'vitest';

import { createOutputMasker, mosaic } from './output-mask';

// 界面输出打码：私密信息明文 / 占位符换成马赛克；流式片段扣尾巴，值被拆成两段也能打上。

describe('mosaic', () => {
  it('手机号留前三后四，邮箱只留首字和域名，姓名留姓', () => {
    expect(mosaic('13812345678')).toBe('138****5678');
    expect(mosaic('zhangsan@example.com')).toBe('z***@example.com');
    expect(mosaic('张三')).toBe('张*');
    expect(mosaic('欧阳娜娜')).toBe('欧**娜');
    expect(mosaic('420106199901011234')).toBe('420****1234');
  });
});

describe('createOutputMasker', () => {
  const m = createOutputMasker(['13812345678', 'zhangsan@example.com', '张三', 'tom', '']);

  it('文本里出现的明文与占位符都打码；短 ASCII 值不参与（tom 不吃掉 tomorrow）', () => {
    expect(m.mask('我是张三，电话 13812345678，邮箱 zhangsan@example.com')).toBe('我是张*，电话 138****5678，邮箱 z***@example.com');
    expect(m.mask('姓名 {{vault:profile.name}}')).toBe('姓名 ****');
    expect(m.mask('see you tomorrow, tom')).toBe('see you tomorrow, tom');
    // ASCII 值按词边界：更长数字串里的一段不动
    expect(m.mask('订单号 9913812345678000')).toBe('订单号 9913812345678000');
  });

  it('maskDeep：只改字符串，Error 等类实例原样保留', () => {
    const err = new Error('boom 13812345678');
    const out = m.maskDeep({ text: '张三', list: ['13812345678'], n: 1, err });
    expect(out).toMatchObject({ text: '张*', list: ['138****5678'], n: 1 });
    expect(out.err).toBe(err);
  });

  it('splitForStream：值被拆在两段时扣下尾巴，并到下一段再打码', () => {
    const a = m.splitForStream('电话是 138123');
    expect(a.emit).toBe('电话是 ');
    expect(a.hold).toBe('138123');
    const b = m.splitForStream(`${a.hold}45678，好的`);
    expect(b.emit).toBe('138****5678，好的');
    expect(b.hold).toBe('');
    const c = m.splitForStream('姓名 {{vault:prof');
    expect(c).toEqual({ emit: '姓名 ', hold: '{{vault:prof' });
    expect(m.splitForStream('普通文字')).toEqual({ emit: '普通文字', hold: '' });
  });

  it('私密库为空时原样放行', () => {
    const empty = createOutputMasker([]);
    const obj = { a: '13812345678' };
    expect(empty.active).toBe(false);
    expect(empty.maskDeep(obj)).toBe(obj);
    expect(empty.splitForStream('138')).toEqual({ emit: '138', hold: '' });
  });
});
