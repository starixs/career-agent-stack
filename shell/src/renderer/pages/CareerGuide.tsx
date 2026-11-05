/**
 * 功能市场：把小芽会的本事摆出来给人看（清单见 components/career/skills/catalog.ts，和内置技能一一对应）。
 *  - 工作台：能独立成事的，一张大卡一幅插画，点了去它那一页；
 *  - 交给小芽：聊天过程中会触发的技能点，一张小卡一幅插画。有东西要选或有成果可看的点开原地换成详情，
 *    自己在做的点了去看结果，其余点了把那句话预填进对话输入框。
 * 是什么靠插画和名字认，页面上不写说明句；没有「添加 / 安装」。
 */
import { CareerPage, SectionTitle, suggestToChat } from '@/components/career/CareerPrimitives';
import { SKILL_POINTS, WORKBENCHES, expands, findSkillPoint, type SkillPoint } from '@/components/career/skills/catalog';
import { SkillPointCard, WorkbenchCard } from '@/components/career/skills/SkillCards';
import { SkillPointDetail } from '@/components/career/skills/SkillPointDetail';
import { useMarketCounts } from '@/components/career/skills/useMarketCounts';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation } from '@/features/career-shell/navModel';
import { useCareerSubView } from '@/features/career-shell/subViewStore';

/** 功能市场首页；其余取值是正在看的技能点 id。 */
const HOME_VIEW = 'home';

function activatePoint(point: SkillPoint, onOpenDetail: (id: string) => void): void {
  if (expands(point)) { onOpenDetail(point.id); return; }
  if (point.open) { requestNavigation(point.open); return; }
  suggestToChat(point.ask, { surface: 'guide', note: `功能市场 · ${point.name}` }, 'prefill');
}

function MarketHome({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
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
            <li key={item.id}><SkillPointCard item={item} count={counts[item.id]} onOpen={() => activatePoint(item, onOpenDetail)} /></li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  const [view, setView] = useCareerSubView<string>('career-guide', HOME_VIEW);
  const point = findSkillPoint(view);
  return (
    <CareerPage embedded={embedded} title="功能市场">
      {point && expands(point)
        ? <SkillPointDetail key={point.id} point={point} onBack={() => setView(HOME_VIEW)} />
        : <MarketHome onOpenDetail={setView} />}
    </CareerPage>
  );
}
