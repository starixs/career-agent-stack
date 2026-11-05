import { estimateGapFromColumns } from './solvers/slider.js';

/** 图像分析只在验证码区域内运行；不读取或保存用户页面其他内容。 */
async function grayscale(png: Uint8Array): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** 滑块拼图：按垂直/水平边缘活跃度找缺口列，再换算成 CSS 像素距离。 */
export async function estimateGapFromImage(png: Uint8Array, cssWidth?: number): Promise<{ distance: number; confidence: number } | null> {
  const { data, width, height } = await grayscale(png);
  if (width < 20 || height < 12) return null;
  const cols = new Array<number>(width).fill(0);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const at = y * width + x;
    cols[x] += Math.abs(data[at] - data[at - 1]) + Math.abs(data[at] - data[at - width]);
  }
  const hit = estimateGapFromColumns(cols);
  if (!hit || hit.confidence < 0.35) return null;
  return { distance: hit.index / width * (cssWidth ?? width), confidence: hit.confidence };
}

export interface RotationGeometry { centerX: number; centerY: number; innerRadius: number; outerRadius: number }

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}

/** 旋转拼图：比较内外环带在各角度的归一化相关性；低区分度时不猜角度。 */
export async function estimateRotationFromImage(png: Uint8Array, geometry?: RotationGeometry): Promise<{ angle: number; confidence: number } | null> {
  const { data, width, height } = await grayscale(png);
  const g = geometry ?? { centerX: width / 2, centerY: height / 2, innerRadius: Math.min(width, height) * 0.2, outerRadius: Math.min(width, height) * 0.32 };
  const sample = (radius: number, angle: number) => {
    const x = Math.round(g.centerX + Math.cos(angle) * radius), y = Math.round(g.centerY + Math.sin(angle) * radius);
    return x < 0 || y < 0 || x >= width || y >= height ? 255 : data[y * width + x];
  };
  const scores: Array<{ angle: number; score: number }> = [];
  for (let angle = 0; angle < 360; angle += 3) {
    const inner: number[] = [], outer: number[] = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 120 * Math.PI * 2;
      inner.push(sample(g.innerRadius * 0.75, t + angle * Math.PI / 180));
      outer.push(sample(g.outerRadius * 0.9, t));
    }
    scores.push({ angle, score: correlation(inner, outer) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0], second = scores[1];
  if (!best || !second || best.score < 0.2) return null;
  const separation = (best.score - second.score) / Math.max(0.05, Math.abs(second.score));
  if (separation < 0.001) return null;
  return { angle: best.angle, confidence: Math.min(1, separation * 5) };
}
