import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { estimateGapFromImage, estimateRotationFromImage } from '../src/image-analysis.js';

async function png(width: number, height: number, pixel: (x: number, y: number) => number): Promise<Uint8Array> {
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

describe('验证码图像分析', () => {
  it('滑块缺口按真实边缘定位并换算 CSS 距离', async () => {
    const image = await png(320, 160, (x, y) => x >= 120 && x < 154 && y >= 25 && y < 120 ? 20 : 150);
    const hit = await estimateGapFromImage(image, 320);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeGreaterThanOrEqual(116);
    expect(hit!.distance).toBeLessThanOrEqual(154);
  });

  it('旋转按环带相关性找角度；平坦图不猜', async () => {
    const image = await png(240, 240, (x, y) => {
      const dx = x - 120, dy = y - 120, r = Math.hypot(dx, dy), theta = Math.atan2(dy, dx);
      if (Math.abs(r - 95) < 4) return 120 + Math.sin(theta) * 100;
      if (Math.abs(r - 53) < 4) return 120 + Math.sin(theta - Math.PI / 2) * 100;
      return 230;
    });
    const hit = await estimateRotationFromImage(image, { centerX: 120, centerY: 120, innerRadius: 70, outerRadius: 105 });
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.angle - 90)).toBeLessThanOrEqual(3);
    const flat = await png(240, 240, () => 150);
    expect(await estimateRotationFromImage(flat)).toBeNull();
  });
});
