/**
 * 功能市场：把小芽会的本事摆出来（清单见 components/career/skills/catalog.ts，和内置技能一一对应）。
 *  - 工作台：能独立成事的技能各有一整页，点了过去；
 *  - 交给小芽：聊天过程中会触发的技能点。点开原地换成详情——特别在哪、怎么用上、做出过什么（照基座展示技能的方式）；
 *  - 点子：一句话的场景提示，一行一个。
 * 没有「添加 / 安装」：点了就用。
 */
import { CareerPage, SectionTitle, suggestToChat } from '@/components/career/CareerPrimitives';
import { SKILL_POINTS, WORKBENCHES, findSkillPoint } from '@/components/career/skills/catalog';
import { SkillPointCard, WorkbenchCard } from '@/components/career/skills/SkillCards';
import { SkillPointDetail } from '@/components/career/skills/SkillPointDetail';
import { useMarketCounts } from '@/components/career/skills/useMarketCounts';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation, type NavTarget } from '@/features/career-shell/navModel';
import { useCareerSubView } from '@/features/career-shell/subViewStore';

/** 点了做什么：去一个页面，或把一句话预填进对话输入框。 */
type MarketAction = { open: NavTarget } | { prefill: string };

export interface Idea { text: string; button: string; action: MarketAction }

export const IDEAS: Idea[] = [
  { text: '刚开始用？先口述一段实习或项目，小芽帮你写进简历。', button: '口述一段', action: { prefill: '我先口述一段实习，帮我整理进简历：' } },
  { text: '丢一个 JD 进来，先看看值不值得投。', button: '评估岗位', action: { prefill: '帮我评估这个岗位，JD 是：' } },
  { text: '绑定邮箱，面试邀请、笔试和拒信自动进来，不用天天刷。', button: '去绑定', action: { open: { kind: 'career-vault' } } },
  { text: '投出去两周没动静？让小芽看看哪些线可以关掉，把精力留给别处。', button: '看看', action: { prefill: '帮我看看哪些投递很久没动静了，哪些可以关掉' } },
  { text: '明天面试？一句话摊开卷宗：投的哪版简历、对这家说过什么。', button: '摊开卷宗', action: { prefill: '我明天面试，把这家公司的卷宗摊开：' } },
  { text: '隔一阵看一次漏斗就够了：投了多少、卡在哪一环。', button: '看我的求职月', action: { open: { kind: 'career-review' } } },
];

/** 功能市场首页；其余取值是正在看的技能点 id。 */
const HOME_VIEW = 'home';

export function runMarketAction(action: MarketAction, note: string): void {
  if ('prefill' in action) {
    suggestToChat(action.prefill, { surface: 'guide', note }, 'prefill');
    return;
  }
  requestNavigation(action.open);
}

function IdeaList() {
  return (
    <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
      {IDEAS.map(idea => (
        <li key={idea.text} className="flex items-center gap-4 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-[var(--ink-2)]">{idea.text}</span>
          <button
            type="button"
            onClick={() => runMarketAction(idea.action, `点子 · ${idea.button}`)}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-[var(--primary)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            {idea.button}
          </button>
        </li>
      ))}
    </ul>
  );
}

function MarketHome({ onOpenPoint }: { onOpenPoint: (id: string) => void }) {
  const counts = useMarketCounts();
  return (
    <div className="max-w-5xl space-y-10 px-6 py-6">
      <section aria-label="工作台">
        <SectionTitle>工作台</SectionTitle>
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {WORKBENCHES.map(item => (
            <li key={item.id}><WorkbenchCard item={item} count={counts[item.id]} onOpen={() => requestNavigation(item.open)} /></li>
          ))}
        </ul>
      </section>
      <section aria-label="交给小芽">
        <SectionTitle>交给小芽</SectionTitle>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {SKILL_POINTS.map(item => (
            <li key={item.id}><SkillPointCard item={item} count={counts[item.id]} onOpen={() => onOpenPoint(item.id)} /></li>
          ))}
        </ul>
      </section>
      <section aria-label="点子">
        <SectionTitle>点子</SectionTitle>
        <IdeaList />
      </section>
    </div>
  );
}

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  const [view, setView] = useCareerSubView<string>('career-guide', HOME_VIEW);
  const point = findSkillPoint(view);
  return (
    <CareerPage embedded={embedded} title="功能市场" subtitle="小芽会的，都在这里">
      {point
        ? <SkillPointDetail key={point.id} point={point} onBack={() => setView(HOME_VIEW)} />
        : <MarketHome onOpenPoint={setView} />}
    </CareerPage>
  );
}
