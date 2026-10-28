/**
 * 本月漏斗：一整个平滑花瓶，四层是同一形状里切出的色带；比上月多的层带一圈同色光晕。
 * 过往月份是共用中轴和顶边的年轮，月份标签排在右侧一列。悬停某一层 → 右侧面板出现；点击钉住。
 */
import type { MonthBoard } from '@/components/career/types';

import { GEO, LAYER_COLORS, LAYER_LIGHT, LAYER_NAMES, TEMPLATE_COUNTS, bandClip, emptySlot, layerTop, rings, scaleBase, vase, widthOf } from './monthFunnelGeometry';

// 比上月多的层带一圈很轻的同色光晕：只是提示，不能把形状糊掉
const GLOW = ['rgba(52,86,196,0.32)', 'rgba(43,147,132,0.32)', 'rgba(219,90,120,0.32)', 'rgba(212,154,42,0.4)'];

export function MonthFunnel({ board, layer, onHover, onPin }: {
  board: MonthBoard;
  layer: number | null;
  onHover: (k: number) => void;
  onPin: (k: number) => void;
}) {
  const { counts, prev } = board;
  // 这个月还没投出：摆一个标准漏斗当初始形状（很淡），数字照写真实的；开始投出后才按数据塑形
  const template = counts[0] <= 0;
  const shapeCounts = template ? TEMPLATE_COUNTS : counts;
  const base = scaleBase(shapeCounts);
  const shape = vase(shapeCounts, base);
  const past = template ? [] : rings(board.history, base);
  const { CX, H } = GEO;
  const bottomY = layerTop(3) + H;
  const svgW = GEO.WIDTH + 64;
  return (
    <div className="relative flex-none" style={{ width: svgW, height: GEO.HEIGHT }}>
      <svg width={svgW} height={GEO.HEIGHT} viewBox={`0 0 ${svgW} ${GEO.HEIGHT}`} aria-hidden className="absolute left-0 top-0 overflow-visible">
        <defs>
          <linearGradient id="mf-fadex" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="0.08" stopColor="#fff" />
            <stop offset="0.92" stopColor="#fff" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="mf-fx"><rect x="0" y="0" width={GEO.WIDTH} height={GEO.HEIGHT} fill="url(#mf-fadex)" /></mask>
          <linearGradient id="mf-page" gradientUnits="userSpaceOnUse" x1="0" y1={GEO.Y0} x2="0" y2={bottomY}>
            {LAYER_COLORS.map((c, k) => <stop key={c} offset={[0.11, 0.37, 0.63, 0.89][k]} stopColor={c} />)}
          </linearGradient>
          {LAYER_COLORS.map((c, k) => {
            const clip = bandClip(k);
            return (
              <g key={c}>
                <clipPath id={`mf-band${k}`}><rect x="0" y={clip.y} width={GEO.WIDTH} height={clip.height} /></clipPath>
                <linearGradient id={`mf-fill${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={LAYER_LIGHT[k]} /><stop offset="1" stopColor={c} /></linearGradient>
              </g>
            );
          })}
        </defs>
        <g mask="url(#mf-fx)">
          {past.slice().reverse().map((r) => (
            <path key={r.key} d={r.d} fill="url(#mf-page)" stroke="url(#mf-page)" fillOpacity={r.style.fill} strokeOpacity={r.style.stroke} strokeWidth={r.style.width} />
          ))}
        </g>
        {shape && LAYER_COLORS.map((c, k) => {
          if (shapeCounts[k] <= 0) return null;
          const grown = !template && !!prev && counts[k] > prev[k];
          const dim = layer !== null && layer !== k;
          const rest = template ? 0.3 : 1;
          return (
            <path
              key={c} d={shape.d} fill={`url(#mf-fill${k})`} clipPath={`url(#mf-band${k})`}
              style={{ opacity: (dim ? 0.42 : 1) * rest, filter: grown ? `drop-shadow(0 0 6px ${GLOW[k]})` : undefined, transition: 'opacity var(--motion-base) cubic-bezier(.2,0,0,1)' }}
            />
          );
        })}
        {!template && LAYER_COLORS.map((c, k) => counts[k] > 0 ? null : (
          <path
            key={`empty-${c}`} d={emptySlot(k)}
            fill="none" stroke="#B8AD9A" strokeWidth={1.5} strokeDasharray="4 5" style={{ opacity: layer !== null && layer !== k ? 0.42 : 1 }}
          />
        ))}
        <g mask="url(#mf-fx)" fill="none" stroke="#fff">
          {past.slice().reverse().map((r) => <path key={r.key} d={r.d} strokeOpacity={r.style.white} strokeWidth={r.style.width} />)}
        </g>
        {past.map((r) => (
          <g key={r.key}>
            <path d={r.leader} fill="none" stroke="var(--muted)" strokeOpacity={r.style.label * 0.6} strokeWidth={0.8} />
            <circle cx={r.dot[0]} cy={r.dot[1]} r={2.2} fill="var(--muted)" fillOpacity={r.style.label * 0.8} />
            <text x={r.text[0]} y={r.text[1]} fontFamily="var(--font-human)" fontSize={15} fill="var(--ink-2)" fillOpacity={r.style.label}>{r.label}</text>
          </g>
        ))}
      </svg>
      {LAYER_NAMES.map((name, k) => {
        const on = layer === k;
        const w = widthOf(shapeCounts[k], base) || GEO.MINW;
        return (
          <span
            key={name} aria-hidden
            className="pointer-events-none absolute whitespace-nowrap font-human transition-[font-size,color] duration-[var(--motion-fast)]"
            style={{ top: layerTop(k) + H / 2 - 13, left: Math.min(GEO.WIDTH - 10, CX + w / 2 + 14), fontSize: on ? 24 : 18, color: on ? 'var(--ink)' : 'var(--muted)' }}
          >
            {counts[k]}
          </span>
        );
      })}
      {LAYER_NAMES.map((name, k) => (
        <button
          key={name} type="button"
          aria-label={`${name} ${counts[k]}${prev ? `，上月 ${prev[k]}` : ''}`}
          aria-pressed={layer === k}
          className="absolute left-0 cursor-pointer rounded-[var(--radius-lg)] border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]"
          style={{ top: layerTop(k) - 6, width: GEO.WIDTH, height: H + GEO.GAP }}
          onMouseEnter={() => onHover(k)}
          onFocus={() => onHover(k)}
          onClick={() => onPin(k)}
        />
      ))}
    </div>
  );
}
