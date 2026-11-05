/**
 * 功能市场卡片上的插画：每个工作台 / 技能点一幅，画的是一眼认得出的东西（对话气泡、答题纸、信封、天平……）。
 * 画法跟产品自己的笔触走：墨线描边、便签黄 / 薄荷 / 钢笔蓝这些主题色块、主体带一道硬投影（同描边按钮）。
 * 只用主题变量，深浅色都成立；不放文字。
 */
import type { ReactNode } from 'react';

import type { SkillPointId, WorkbenchId } from './catalog';

const INK = 'var(--hard)';
const PAPER = 'var(--paper)';
const NOTE = 'var(--note)';
const MINT = 'var(--mint)';
const BLUE = 'var(--primary)';
const RED = 'var(--seal)';
const SKY = 'var(--info-bg)';
const FAINT = 'var(--line-2)';

/** 所有描边同一支笔。 */
const PEN = { stroke: INK, strokeWidth: 1.75, strokeLinejoin: 'round', strokeLinecap: 'round' } as const;
/** 硬投影往右下偏这么多。 */
const DROP = 3;

/** 带硬投影的圆角块：纸、窗口、气泡的底。 */
function Slab({ x, y, w, h, r = 4, fill = PAPER }: { x: number; y: number; w: number; h: number; r?: number; fill?: string }) {
  return (
    <>
      <rect x={x + DROP} y={y + DROP} width={w} height={h} rx={r} fill={INK} />
      <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} {...PEN} />
    </>
  );
}

/** 一行字：圆头墨线；faint 是次要的行。 */
function Rule({ x, y, w, faint = false }: { x: number; y: number; w: number; faint?: boolean }) {
  return <line x1={x} y1={y} x2={x + w} y2={y} stroke={faint ? FAINT : INK} strokeWidth={2} strokeLinecap="round" />;
}

function Stroke({ d, fill = 'none' }: { d: string; fill?: string }) {
  return <path d={d} fill={fill} {...PEN} />;
}

const Tick = ({ x, y }: { x: number; y: number }) => <Stroke d={`M${x - 3} ${y}l2.5 2.5 4.5-5`} />;

export type ArtId = WorkbenchId | SkillPointId;

const ART: Record<ArtId, ReactNode> = {
  // 一问一答：后面是面试官的话，前面是抛过来的问号
  interview: (
    <>
      <Stroke d="M22 14h40a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H38l-8 8v-8h-8a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z" fill={PAPER} />
      <circle cx={30} cy={30} r={2.2} fill={INK} /><circle cx={42} cy={30} r={2.2} fill={INK} /><circle cx={54} cy={30} r={2.2} fill={INK} />
      <path d="M61 33h38a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6h-2v8l-8-8H61a6 6 0 0 1-6-6V39a6 6 0 0 1 6-6z" fill={INK} transform={`translate(${DROP} ${DROP})`} />
      <Stroke d="M61 33h38a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6h-2v8l-8-8H61a6 6 0 0 1-6-6V39a6 6 0 0 1 6-6z" fill={NOTE} />
      <path d="M73 45a7 7 0 1 1 10 6c-2 1-3 2-3 4" fill="none" stroke={INK} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={80} cy={60} r={1.8} fill={INK} />
    </>
  ),
  // 一张答题纸：选项里勾中一个，旁边一支笔
  exam: (
    <>
      <Slab x={24} y={10} w={52} h={60} />
      {[24, 40, 56].map((cy, i) => (
        <g key={cy}>
          <circle cx={37} cy={cy} r={5.5} fill={i === 1 ? MINT : PAPER} {...PEN} />
          {i === 1 && <Tick x={36.5} y={cy} />}
          <Rule x={48} y={cy} w={i === 2 ? 14 : 20} faint={i !== 1} />
        </g>
      ))}
      <g transform="rotate(28 96 40)">
        <rect x={91} y={14} width={10} height={40} fill={BLUE} {...PEN} />
        <Stroke d="M91 54l5 10 5-10z" fill={PAPER} />
        <rect x={91} y={14} width={10} height={7} fill={NOTE} {...PEN} />
      </g>
    </>
  ),
  // 一页简历：头像、名字、几行经历，其中一行用荧光笔划过
  resume: (
    <>
      <Slab x={34} y={8} w={52} h={64} />
      <circle cx={47} cy={23} r={7} fill={NOTE} {...PEN} />
      <Rule x={60} y={20} w={18} /><Rule x={60} y={27} w={12} faint />
      <rect x={40} y={44} width={34} height={8} rx={2} fill="var(--mark)" />
      <Rule x={42} y={40} w={36} faint /><Rule x={42} y={48} w={28} /><Rule x={42} y={56} w={34} faint /><Rule x={42} y={64} w={22} faint />
    </>
  ),
  // 一个网页窗口：表单一项项填好
  apply: (
    <>
      <Slab x={16} y={12} w={88} h={56} r={6} />
      <line x1={16} y1={25} x2={104} y2={25} {...PEN} />
      <circle cx={25} cy={18.5} r={2.5} fill={RED} /><circle cx={33} cy={18.5} r={2.5} fill={NOTE} {...PEN} strokeWidth={1} /><circle cx={41} cy={18.5} r={2.5} fill={MINT} {...PEN} strokeWidth={1} />
      <rect x={26} y={32} width={48} height={10} rx={3} fill={PAPER} {...PEN} /><Rule x={31} y={37} w={22} />
      <rect x={26} y={48} width={48} height={10} rx={3} fill={PAPER} {...PEN} /><Rule x={31} y={53} w={14} faint />
      <circle cx={88} cy={37} r={6} fill={MINT} {...PEN} /><Tick x={87.5} y={37} />
      <circle cx={88} cy={53} r={6} fill={PAPER} {...PEN} strokeDasharray="3 3" />
    </>
  ),
  // 一栋楼，放大镜里是红黄绿灯
  company: (
    <>
      <Slab x={24} y={16} w={40} h={52} r={3} fill={SKY} />
      {[26, 38, 50].flatMap(cy => [32, 46].map(cx => <rect key={`${cx}:${cy}`} x={cx} y={cy} width={8} height={7} rx={1} fill={PAPER} {...PEN} strokeWidth={1.25} />))}
      <circle cx={84} cy={42} r={17} fill={INK} transform={`translate(${DROP} ${DROP})`} />
      <circle cx={84} cy={42} r={17} fill={PAPER} {...PEN} />
      <line x1={96} y1={55} x2={106} y2={66} stroke={INK} strokeWidth={5} strokeLinecap="round" />
      <circle cx={84} cy={32} r={4} fill={PAPER} {...PEN} strokeWidth={1.25} /><circle cx={84} cy={42} r={4} fill="var(--mark)" {...PEN} strokeWidth={1.25} /><circle cx={84} cy={52} r={4} fill={PAPER} {...PEN} strokeWidth={1.25} />
    </>
  ),
  // 两份 Offer 并排，一长一短两根薪资条
  offer: (
    <>
      <Slab x={14} y={14} w={38} h={52} />
      <rect x={14} y={14} width={38} height={12} rx={4} fill={NOTE} {...PEN} />
      <Rule x={21} y={36} w={24} faint /><rect x={21} y={48} width={24} height={8} rx={2} fill={BLUE} {...PEN} />
      <Slab x={68} y={14} w={38} h={52} />
      <rect x={68} y={14} width={38} height={12} rx={4} fill={MINT} {...PEN} />
      <Rule x={75} y={36} w={24} faint /><rect x={75} y={48} width={15} height={8} rx={2} fill={BLUE} {...PEN} />
      <Stroke d="M56 34h8m-3-3 3 3-3 3M64 46h-8m3-3-3 3 3 3" />
    </>
  ),
  // 一层层收窄的漏斗
  month: (
    <>
      <Stroke d="M18 12h84l-12 18H30z" fill={NOTE} />
      <Stroke d="M33 34h54l-10 16H43z" fill={MINT} />
      <Stroke d="M46 54h28l-6 14H52z" fill={BLUE} />
    </>
  ),
  // 一支话筒
  'experience-interview': (
    <>
      <rect x={53} y={13} width={20} height={36} rx={10} fill={INK} />
      <rect x={50} y={10} width={20} height={36} rx={10} fill={NOTE} {...PEN} />
      <Rule x={56} y={22} w={8} /><Rule x={56} y={29} w={8} /><Rule x={56} y={36} w={8} />
      <Stroke d="M40 38a20 20 0 0 0 40 0M60 58v10M48 68h24" />
      <Stroke d="M28 30q-5 8 0 16M92 30q5 8 0 16" />
    </>
  ),
  // 五边形雷达图：五项评分
  'job-evaluate': (
    <>
      <path d="M60 10 90.4 32.1 78.8 67.9H41.2L29.6 32.1z" fill={INK} transform={`translate(${DROP} ${DROP})`} />
      <Stroke d="M60 10 90.4 32.1 78.8 67.9H41.2L29.6 32.1z" fill={PAPER} />
      <path d="M60 42V10M60 42l30.4-9.9M60 42l18.8 25.9M60 42 41.2 67.9M60 42 29.6 32.1" stroke={FAINT} strokeWidth={1.25} />
      <Stroke d="M60 14 79 35.8 75.3 63 53 51.7 39.1 35.2z" fill={MINT} />
      {[[60, 14], [79, 35.8], [75.3, 63], [53, 51.7], [39.1, 35.2]].map(([cx, cy]) => <circle key={`${cx}:${cy}`} cx={cx} cy={cy} r={3.2} fill={INK} />)}
    </>
  ),
  // 一根路牌，两块指向不同方向的牌子
  'direction-explore': (
    <>
      <line x1={60} y1={10} x2={60} y2={70} stroke={INK} strokeWidth={3} strokeLinecap="round" />
      <Stroke d="M60 16h30l9 9-9 9H60z" fill={NOTE} />
      <Stroke d="M60 40H30l-9 9 9 9h30z" fill={MINT} />
      <Rule x={50} y={70} w={20} />
    </>
  ),
  // 三行清单：做完的、做了一半的、还没做的
  'gap-plan': (
    <>
      {[[8, MINT], [31, NOTE], [54, PAPER]].map(([y, fill], i) => (
        <g key={String(y)}>
          <rect x={20} y={Number(y)} width={18} height={18} rx={4} fill={String(fill)} {...PEN} />
          {i === 0 && <Tick x={28.5} y={Number(y) + 9} />}
          {i === 1 && <Rule x={25} y={Number(y) + 9} w={8} />}
          <line x1={50} y1={Number(y) + 9} x2={i === 1 ? 86 : 100} y2={Number(y) + 9} stroke={i === 2 ? FAINT : INK} strokeWidth={2.5} strokeLinecap="round" />
        </g>
      ))}
    </>
  ),
  // 一段话：一对引号加几行字
  'material-draft': (
    <>
      <Slab x={16} y={12} w={88} h={56} r={5} />
      <path d="M27 33a6 6 0 1 1 6 6l-2 6h-5zM43 33a6 6 0 1 1 6 6l-2 6h-5z" fill={BLUE} />
      <Rule x={62} y={28} w={32} /><Rule x={62} y={37} w={24} faint />
      <Rule x={26} y={52} w={66} faint /><Rule x={26} y={60} w={44} faint />
    </>
  ),
};

export function SkillArt({ id, className = '' }: { id: ArtId; className?: string }) {
  return <svg viewBox="0 0 120 80" aria-hidden className={className}>{ART[id]}</svg>;
}
