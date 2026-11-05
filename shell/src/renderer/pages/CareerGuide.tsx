/**
 * 功能市场：把小芽会的本事摆出来（清单见 components/career/skills/catalog.ts，和内置技能一一对应）。
 *  - 工作台：一张小纸片上放这个工作台里的真实内容，点了过去；
 *  - 交给小芽：聊天过程中会触发的技能点，一行一个，点开就地展开或直接用。
 * 页面上不写说明性的句子，没有「添加 / 安装」：点了就用。
 */
import { CareerPage, SectionTitle } from '@/components/career/CareerPrimitives';
import { WORKBENCHES, findSkillPoint } from '@/components/career/skills/catalog';
import { SkillPointList } from '@/components/career/skills/SkillPointList';
import { useMarketData } from '@/components/career/skills/useMarketData';
import { WorkbenchSheet } from '@/components/career/skills/WorkbenchSheets';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation } from '@/features/career-shell/navModel';
import { useCareerSubView } from '@/features/career-shell/subViewStore';

/** 没有展开任何技能点；其余取值是展开着的技能点 id。 */
const HOME_VIEW = 'home';

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  const [view, setView] = useCareerSubView<string>('career-guide', HOME_VIEW);
  const data = useMarketData();
  const openId = findSkillPoint(view)?.id ?? null;
  return (
    <CareerPage embedded={embedded} title="功能市场">
      <div className="max-w-4xl space-y-10 px-6 py-6">
        <section aria-label="工作台">
          <SectionTitle>工作台</SectionTitle>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-4">
            {WORKBENCHES.map(item => (
              <li key={item.id}><WorkbenchSheet item={item} data={data} onOpen={() => requestNavigation(item.open)} /></li>
            ))}
          </ul>
        </section>
        <section aria-label="交给小芽">
          <SectionTitle>交给小芽</SectionTitle>
          <SkillPointList openId={openId} done={data.done} onToggle={id => setView(id === openId ? HOME_VIEW : id)} />
        </section>
      </div>
    </CareerPage>
  );
}
