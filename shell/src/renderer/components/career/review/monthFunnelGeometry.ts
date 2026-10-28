/**
 * 「我的求职月」漏斗的几何（纯函数）。本月是一整个平滑花瓶，四层是从同一形状切出的色带，每层正中的宽度 = 真实数量；
 * 过往月份用同一函数画轮廓，和本月共用中轴与顶边（年轮式）。宽度用保单调的三次插值（PCHIP），只往下收、肩部不鼓。
 */
import type { LayerCounts } from '@/components/career/types';

export const GEO = { FULL: 500, MINW: 30, H: 86, GAP: 14, CX: 280, Y0: 22, WIDTH: 560, HEIGHT: 440 } as const;

/** 四层的颜色：投出蓝、笔试/测评青、面试珊瑚、Offer 芥黄。整页的图都沿用这一套，漏斗本身就是图例。 */
export const LAYER_COLORS = ['#3456C4', '#2B9384', '#DB5A78', '#D49A2A'] as const;
export const LAYER_LIGHT = ['#6E86DA', '#5FB3A6', '#E888A0', '#E6B95C'] as const;
export const LAYER_INK = ['#2F4BA0', '#1F7368', '#B43E5D', '#8A6210'] as const;
export const LAYER_NAMES = ['投出', '笔试/测评', '面试', 'Offer'] as const;

export const layerTop = (k: number) => GEO.Y0 + k * (GEO.H + GEO.GAP);

/** 某一层画多宽：按本月投出折算，最窄也看得见。 */
export function widthOf(x: number, base: number): number {
  if (x <= 0 || base <= 0) return 0;
  return Math.max(GEO.MINW, Math.min(1400, (x / base) * GEO.FULL));
}

export interface Vase { d: string; halfWidthAt: (y: number) => number }

/** 花瓶轮廓：顶边、每层正中、末层底部收口，PCHIP 插值后按 3px 采样。counts[0] 为 0 时返回 null。 */
export function vase(counts: LayerCounts, base: number): Vase | null {
  const ks = [0, 1, 2, 3].filter((k) => counts[k] > 0);
  if (!ks.length || counts[0] <= 0) return null;
  const { CX, Y0, H } = GEO;
  const last = ks[ks.length - 1];
  const pts: Array<[number, number]> = [[Y0, widthOf(counts[0], base) / 2]];
  ks.forEach((k) => pts.push([layerTop(k) + H / 2, widthOf(counts[k], base) / 2]));
  pts.push([layerTop(last) + H, Math.max(6, (widthOf(counts[last], base) / 2) * 0.62)]);
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const m = xs.length;
  const dx: number[] = []; const sl: number[] = [];
  for (let i = 0; i < m - 1; i++) { dx.push(xs[i + 1] - xs[i]); sl.push((ys[i + 1] - ys[i]) / dx[i]); }
  const tg = [0];
  for (let i = 1; i < m - 1; i++) tg.push(sl[i - 1] * sl[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / sl[i - 1] + (dx[i] + 2 * dx[i - 1]) / sl[i]));
  tg.push(sl[m - 2]);
  const f = (y: number) => {
    let i = 0; while (i < m - 2 && y > xs[i + 1]) i++;
    const h = dx[i]; const s = (y - xs[i]) / h; const s2 = s * s; const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * tg[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * tg[i + 1];
  };
  const smp: Array<[number, number]> = [];
  for (let y = xs[0]; y < xs[m - 1]; y += 3) smp.push([y, f(y)]);
  smp.push([xs[m - 1], ys[m - 1]]);
  const yE = xs[m - 1]; const tip = ys[m - 1];
  let d = `M ${(CX - smp[0][1]).toFixed(1)} ${smp[0][0]}`;
  for (const [y, hw] of smp) d += ` L ${(CX - hw).toFixed(1)} ${y.toFixed(1)}`;
  d += ` C ${(CX - tip).toFixed(1)} ${yE + 14}, ${(CX + tip).toFixed(1)} ${yE + 14}, ${(CX + tip).toFixed(1)} ${yE}`;
  for (let i = smp.length - 1; i >= 0; i--) d += ` L ${(CX + smp[i][1]).toFixed(1)} ${smp[i][0].toFixed(1)}`;
  return { d: `${d} Z`, halfWidthAt: (y) => f(Math.min(Math.max(y, xs[0]), xs[m - 1])) };
}

/** 年轮：越旧越细越淡。外面是渐变彩线 + 极淡底色，压在色块里的部分是白色刻线。 */
export const RING_STYLE = [
  { fill: 0.08, stroke: 0.9, width: 1.5, white: 0.75, label: 1 },
  { fill: 0.05, stroke: 0.55, width: 1.2, white: 0.5, label: 0.72 },
  { fill: 0.03, stroke: 0.35, width: 1, white: 0.32, label: 0.44 },
] as const;

export interface Ring { key: string; label: string; d: string; style: (typeof RING_STYLE)[number]; leader: string; dot: [number, number]; text: [number, number] }

/** 过往月份的年轮和右侧标签列（细引线连到第二层中线处的轮廓边）。 */
export function rings(history: Array<{ key: string; month: number; counts: LayerCounts }>, base: number): Ring[] {
  const ly = layerTop(1) + GEO.H / 2;
  return history.slice(0, 3).flatMap((h, i) => {
    const v = vase(h.counts, base);
    if (!v) return [];
    const ex = Math.min(GEO.WIDTH - 8, GEO.CX + v.halfWidthAt(ly));
    const lx = 576; const y = 92 + i * 26;
    return [{
      key: h.key, label: `${h.month} 月`, d: v.d, style: RING_STYLE[i],
      leader: `M ${ex.toFixed(1)} ${ly} C ${(ex + 30).toFixed(1)} ${ly}, ${lx - 36} ${y}, ${lx - 6} ${y}`,
      dot: [ex, ly], text: [lx, y + 5],
    }];
  });
}

/** 每条色带的裁切范围：色带之间留一道细纸缝。 */
export function bandClip(k: number): { y: number; height: number } {
  const top = layerTop(k); const seam = GEO.GAP / 2 - 1.5;
  const y = k === 0 ? top - 2 : top - seam;
  const bottom = top + GEO.H + (k === 3 ? 30 : seam);
  return { y, height: bottom - y };
}

/** 从上一层走到这一层的比例，和上月比；两个月的上一层都满 10 份才比，变好才返回。 */
export function improvedRate(counts: LayerCounts, prev: LayerCounts | null, k: number): { now: number; before: number } | null {
  if (!prev || k === 0 || counts[k - 1] < 10 || prev[k - 1] < 10) return null;
  const now = counts[k] / counts[k - 1]; const before = prev[k] / prev[k - 1];
  return now > before ? { now, before } : null;
}
