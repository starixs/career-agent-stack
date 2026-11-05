/**
 * 产出小样：画出这个技能交回来的东西长什么样（追问链、五项评分、对比表……），让人不读字也认得出。
 * 只画形状，不放假数据；颜色只用主题变量（墨线表示文字，钢笔蓝表示重点，状态色表示判断）。
 */
import type { ReactNode } from 'react';

import type { SpecimenKind } from './catalog';

const FAINT = 'var(--line-2)';
const INK = 'var(--muted)';
const ACCENT = 'var(--primary)';
const GOOD = 'var(--success)';
const WARN = 'var(--warning)';
const BAD = 'var(--danger)';

/** 一行字：圆头短线。 */
function Line({ x, y, w, color = FAINT, h = 3 }: { x: number; y: number; w: number; color?: string; h?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={color} />;
}

function Dot({ x, y, color, r = 2.5 }: { x: number; y: number; color: string; r?: number }) {
  return <circle cx={x} cy={y} r={r} fill={color} />;
}

function Box({ x, y, w, h, color = FAINT }: { x: number; y: number; w: number; h: number; color?: string }) {
  return <rect x={x} y={y} width={w} height={h} rx={2.5} fill="none" stroke={color} strokeWidth={1.25} />;
}

function Stroke({ d, color = FAINT }: { d: string; color?: string }) {
  return <path d={d} fill="none" stroke={color} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />;
}

const SHAPES: Record<SpecimenKind, ReactNode> = {
  // 追问一层层往下钻
  chain: (
    <>
      <Dot x={9} y={10} color={BAD} /><Line x={16} y={8.5} w={56} color={INK} />
      <Stroke d="M20 16v7h8" /><Line x={32} y={21.5} w={50} />
      <Stroke d="M36 29v7h8" /><Line x={48} y={34.5} w={38} />
      <Stroke d="M52 42v7h8" /><Line x={64} y={47.5} w={24} color={ACCENT} />
    </>
  ),
  // 一道题，下面是答案
  answer: (
    <>
      <Box x={6} y={6} w={84} h={22} /><Line x={12} y={12} w={60} color={INK} /><Line x={12} y={19} w={42} />
      <Stroke d="M10 43l4 4 8-9" color={GOOD} /><Line x={28} y={38} w={50} color={ACCENT} /><Line x={28} y={46} w={34} />
    </>
  ),
  // 一页简历
  page: (
    <>
      <Box x={24} y={3} w={48} h={54} /><Line x={30} y={10} w={20} color={INK} /><Box x={58} y={8} w={8} h={10} />
      <Line x={30} y={17} w={14} /><Line x={30} y={26} w={36} /><Line x={30} y={32} w={30} /><Line x={30} y={38} w={34} color={ACCENT} />
      <Line x={30} y={44} w={26} /><Line x={30} y={50} w={32} />
    </>
  ),
  // 一项项填好的表单
  form: (
    <>
      <Line x={6} y={9} w={14} /><Box x={26} y={5} w={50} h={10} /><Stroke d="M80 10l3 3 5-6" color={GOOD} />
      <Line x={6} y={27} w={18} /><Box x={26} y={23} w={50} h={10} /><Stroke d="M80 28l3 3 5-6" color={GOOD} />
      <Line x={6} y={45} w={12} /><Box x={26} y={41} w={50} h={10} color={ACCENT} /><Line x={30} y={44.5} w={18} color={ACCENT} />
    </>
  ),
  // 红黄绿灯 + 几段报告
  report: (
    <>
      <Box x={6} y={8} w={14} h={44} /><Dot x={13} y={17} color={FAINT} r={3.5} /><Dot x={13} y={30} color={WARN} r={3.5} /><Dot x={13} y={43} color={FAINT} r={3.5} />
      <Line x={28} y={10} w={40} color={INK} /><Line x={28} y={19} w={58} /><Line x={28} y={26} w={50} />
      <Line x={28} y={37} w={28} color={ACCENT} /><Line x={28} y={45} w={54} /><Line x={28} y={52} w={36} />
    </>
  ),
  // 两三个 Offer 并排比
  table: (
    <>
      <Box x={6} y={6} w={84} h={48} /><Stroke d="M6 19h84M6 31h84M6 43h84M30 6v48M60 6v48" />
      <Line x={36} y={11} w={16} color={INK} /><Line x={66} y={11} w={16} color={INK} />
      <Line x={11} y={23.5} w={12} /><Line x={36} y={23.5} w={18} color={ACCENT} /><Line x={66} y={23.5} w={12} />
      <Line x={11} y={35.5} w={10} /><Line x={36} y={35.5} w={12} /><Line x={66} y={35.5} w={16} />
      <Line x={11} y={47.5} w={14} /><Line x={36} y={47.5} w={14} /><Line x={66} y={47.5} w={10} />
    </>
  ),
  // 一层层收窄
  funnel: (
    <>
      <Line x={8} y={8} w={80} h={8} color={FAINT} /><Line x={20} y={21} w={56} h={8} color={FAINT} />
      <Line x={32} y={34} w={32} h={8} color={INK} /><Line x={41} y={47} w={14} h={8} color={ACCENT} />
    </>
  ),
  // 五项分开打分
  scores: (
    <>
      {[46, 40, 52, 28, 36].map((w, i) => (
        <g key={i}>
          <Line x={6} y={7 + i * 10.5} w={12} />
          <Line x={24} y={6.5 + i * 10.5} w={62} h={4} color="var(--inset)" />
          <Line x={24} y={6.5 + i * 10.5} w={w} h={4} color={i === 3 ? WARN : ACCENT} />
        </g>
      ))}
    </>
  ),
  // 原句划掉，换成新句
  diff: (
    <>
      <Line x={6} y={10} w={70} /><Line x={6} y={21} w={56} color={INK} /><Stroke d="M4 22.5h62" color={BAD} />
      <Stroke d="M8 35v6M5 38h6" color={GOOD} /><Line x={16} y={36.5} w={66} color={ACCENT} /><Line x={16} y={45} w={40} color={ACCENT} />
    </>
  ),
  // 一份文件拆成一条条
  intake: (
    <>
      <Box x={6} y={8} w={26} h={44} /><Line x={11} y={16} w={16} color={INK} /><Line x={11} y={24} w={12} /><Line x={11} y={32} w={16} /><Line x={11} y={40} w={10} />
      <Stroke d="M38 30h10M44 26l4 4-4 4" color={ACCENT} />
      <Box x={54} y={7} w={36} h={12} /><Line x={59} y={11.5} w={22} color={INK} />
      <Box x={54} y={24} w={36} h={12} /><Line x={59} y={28.5} w={26} />
      <Box x={54} y={41} w={36} h={12} /><Line x={59} y={45.5} w={18} />
    </>
  ),
  // 一问一答
  talk: (
    <>
      <Box x={6} y={6} w={46} h={14} /><Line x={12} y={11.5} w={30} color={INK} />
      <Box x={36} y={24} w={54} h={14} color={ACCENT} /><Line x={42} y={29.5} w={40} color={ACCENT} />
      <Box x={6} y={42} w={38} h={14} /><Line x={12} y={47.5} w={24} color={INK} />
    </>
  ),
  // 一个起点，分出几个方向
  branches: (
    <>
      <Dot x={12} y={30} color={INK} r={4} />
      <Stroke d="M16 30h14M30 30V12h12M30 30v18h12M30 30h12" />
      <Line x={46} y={10.5} w={40} color={ACCENT} /><Line x={46} y={28.5} w={32} /><Line x={46} y={46.5} w={36} />
    </>
  ),
  // 已经有 / 缺证据 / 真没有
  gaps: (
    <>
      {[GOOD, WARN, BAD].map((color, i) => (
        <g key={color}>
          <Box x={6 + i * 29} y={6} w={25} h={48} />
          <Dot x={12 + i * 29} y={13} color={color} />
          <Line x={11 + i * 29} y={21} w={15} /><Line x={11 + i * 29} y={28} w={11} />
          {i < 2 && <Line x={11 + i * 29} y={35} w={14} />}
        </g>
      ))}
    </>
  ),
  // 一段写好的文字，短中长
  essay: (
    <>
      <Stroke d="M8 8v6M12 8v6" color={ACCENT} />
      <Line x={18} y={9} w={64} color={INK} /><Line x={18} y={17} w={70} /><Line x={18} y={25} w={48} />
      <Box x={6} y={38} w={20} h={14} /><Box x={32} y={38} w={26} h={14} color={ACCENT} /><Box x={64} y={38} w={26} h={14} />
      <Line x={10} y={43.5} w={10} /><Line x={36} y={43.5} w={16} color={ACCENT} /><Line x={68} y={43.5} w={18} />
    </>
  ),
  // 一封信
  letter: (
    <>
      <Box x={8} y={10} w={80} h={42} /><Stroke d="M8 12l40 22 40-22" color={INK} />
      <Line x={16} y={42} w={24} color={ACCENT} />
    </>
  ),
  // 一句开场白
  bubble: (
    <>
      <Stroke d="M10 8h76a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H30l-10 10V40h-10a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" />
      <Line x={14} y={17} w={54} color={ACCENT} /><Line x={14} y={25} w={66} /><Line x={14} y={32} w={30} />
    </>
  ),
  // 进来的信按类别分好
  sorted: (
    <>
      {[ACCENT, WARN, FAINT].map((color, i) => (
        <g key={i}>
          <Box x={6} y={6 + i * 17} w={84} h={13} />
          <Line x={11} y={11 + i * 17} w={14} h={4} color={color} />
          <Line x={31} y={11.5 + i * 17} w={i === 1 ? 40 : 50} color={i === 0 ? INK : FAINT} />
        </g>
      ))}
    </>
  ),
  // 一条时间线，现在在这
  timeline: (
    <>
      <Stroke d="M6 30h84" />
      <Dot x={16} y={30} color={FAINT} r={3.5} /><Dot x={40} y={30} color={ACCENT} r={4.5} /><Dot x={64} y={30} color={FAINT} r={3.5} /><Dot x={86} y={30} color={FAINT} r={3.5} />
      <Line x={8} y={40} w={16} /><Line x={30} y={40} w={20} color={INK} /><Line x={56} y={40} w={16} /><Line x={78} y={40} w={12} />
      <Line x={30} y={14} w={20} color={ACCENT} /><Stroke d="M40 19v5" color={ACCENT} />
    </>
  ),
};

export function Specimen({ kind, className = '' }: { kind: SpecimenKind; className?: string }) {
  return (
    <svg viewBox="0 0 96 60" aria-hidden className={className}>
      {SHAPES[kind]}
    </svg>
  );
}
