import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 「有没有 canvas」在模块里只探测一次：每条用例重新导入，才能分别测有 / 没有 canvas 两种环境。
const load = async () => {
  vi.resetModules();
  const [{ HandwrittenLine }, { QuoteNote }] = await Promise.all([import('./HandwrittenLine'), import('./QuoteNote')]);
  return { HandwrittenLine, QuoteNote };
};

// jsdom 没有 canvas：给一个最小的 2D 替身——fill 之后 getImageData 返回一块实心墨迹，putImageData 记下画了几次。
function fakeContext() {
  let filled = false;
  const size = 120;
  return {
    setTransform: vi.fn(),
    fill: vi.fn(() => { filled = true; }),
    getImageData: vi.fn(() => {
      const data = new Uint8ClampedArray(size * size * 4);
      if (filled) for (let y = 30; y < 90; y++) for (let x = 40; x < 80; x++) data[(y * size + x) * 4 + 3] = 255;
      return { data };
    }),
    createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
    putImageData: vi.fn(),
  };
}

const contexts: Array<ReturnType<typeof fakeContext>> = [];

beforeEach(() => {
  contexts.length = 0;
  vi.stubGlobal('Path2D', class { constructor(public d: string) {} });
  // 走「减少动态效果」分支：直接画出终态，不跑 6 秒的动画。
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const ctx = fakeContext();
    contexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HandwrittenLine', () => {
  it('draws every character, full stop included, on its own canvas and reads as the plain sentence', async () => {
    const { HandwrittenLine } = await load();
    const onWritten = vi.fn();
    render(<HandwrittenLine text="歇一歇也算数。" playKey="test-1" onWritten={onWritten} />);
    const line = screen.getByRole('img', { name: '歇一歇也算数。' });
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
    expect(line.querySelectorAll('canvas')).toHaveLength(7);
    expect(line.querySelectorAll('.hw-glyph-narrow')).toHaveLength(1);
    // 每块显示用的画布都被画上了墨（终态）
    const painted = contexts.filter(c => c.putImageData.mock.calls.length > 0);
    expect(painted.length).toBe(7);
  });

  it('falls back to the plain sentence in the hand font when canvas is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { HandwrittenLine } = await load();
    const onWritten = vi.fn();
    const { container } = render(<HandwrittenLine text="歇一歇也算数。" playKey="test-2" onWritten={onWritten} />);
    // 先等数据加载完、判定不能手写（加载中的占位也是文楷文字，不能拿它当结论）
    await waitFor(() => expect(onWritten).toHaveBeenCalled());
    expect(container.querySelector('.font-human')?.textContent).toBe('歇一歇也算数。');
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.hw-line')).toBeNull();
  });
});

describe('QuoteNote', () => {
  it('writes the scene line and reveals its source afterwards', async () => {
    const { QuoteNote } = await load();
    const { container } = render(<QuoteNote scene="quiet" seed="test" />);
    expect(container.querySelector('figure')?.dataset.quoteScene).toBe('quiet');
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());
    const caption = container.querySelector('figcaption');
    if (caption) await waitFor(() => expect(caption.className).toContain('opacity-100'));
  });
});
