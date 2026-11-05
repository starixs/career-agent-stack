/**
 * 技能点详情：点开一张技能点卡看到的那一页（卡片 → 原地换成详情，左上角返回）。
 * 上面是这个技能的插画、名字和「选一下、点一下」的开始条；下面是它做出过的成果，用它自己的样子摆出来。
 */
import { ArrowLeft } from 'lucide-react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { Button } from '../CareerPrimitives';

import type { SkillPoint } from './catalog';
import { SkillArt } from './SkillArt';
import { SkillResults } from './SkillResults';
import { StartBar } from './StartBar';

export function SkillPointDetail({ point, onBack }: { point: SkillPoint; onBack: () => void }) {
  return (
    <div className="max-w-4xl space-y-8 px-6 py-5">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />功能市场
      </Button>

      <header className="flex flex-wrap items-center gap-6">
        <div className="flex h-[104px] w-[156px] shrink-0 items-center justify-center rounded-lg bg-[var(--inset)]">
          <SkillArt id={point.id} className="h-20 w-[120px]" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="font-human text-2xl font-semibold text-[var(--ink)]">{point.name}</h2>
            <p className="mt-0.5 text-sm text-[var(--muted)]">{point.gives}</p>
          </div>
          {/* 这一轮回复结束后，对话里会有一张卡带他回到这一页看成果 */}
          {point.start && <StartBar spec={point.start} surface={pageSurfaceId({ kind: 'career-guide', view: point.id })} />}
        </div>
      </header>

      {point.results && <SkillResults kind={point.results} />}
    </div>
  );
}
