/**
 * 按容器宽度等比缩放一块定尺寸的内容（漏斗是按像素算的 SVG + 绝对定位的悬停区）。
 * 用 transform 缩放，悬停和点击的位置跟着一起缩，不用改几何。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function FitWidth({ width, height, maxScale, children }: { width: number; height: number; maxScale: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    // 测试环境没有 ResizeObserver：按原尺寸画
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect.width ?? width;
      setScale(Math.min(maxScale, box / width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, maxScale]);
  return (
    <div ref={ref} className="min-w-0" style={{ height: height * scale }}>
      <div style={{ width, transform: `scale(${scale})`, transformOrigin: '0 0' }}>{children}</div>
    </div>
  );
}
