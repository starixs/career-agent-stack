/**
 * 技能点详情：点开一张技能点卡看到的那一页（照基座：卡片 → 原地换成详情，左上角返回）。
 * 回答三件事：它特别在哪、怎么用上（选一下点一下，或者说哪句话）、它替你做出过什么。
 */
import { ArrowLeft } from 'lucide-react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';
import { requestNavigation } from '@/features/career-shell/navModel';

import { Button, suggestToChat } from '../CareerPrimitives';

import type { SkillPoint } from './catalog';
import { SkillResults } from './SkillResults';
import { Specimen } from './Specimen';
import { StartBar } from './StartBar';

function HowToUse({ point }: { point: SkillPoint }) {
  // 这一轮回复结束后，对话里会有一张卡带他回到这一页看成果
  const surface = pageSurfaceId({ kind: 'career-guide', view: point.id });
  const auto = point.auto;
  return (
    <section className="space-y-3">
      {point.start && <StartBar spec={point.start} surface={surface} />}
      {auto && <Button onClick={() => requestNavigation(auto.open)}>{auto.label}</Button>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--muted)]">
        <span>{point.start || auto ? '聊天时这样说也会用上' : '在对话里这样说'}</span>
        <button
          type="button"
          onClick={() => suggestToChat(point.ask, { surface, note: `功能市场 · ${point.name}` }, 'prefill')}
          className="rounded-md px-1.5 py-0.5 text-left text-[var(--primary)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        >
          「{point.ask}」
        </button>
      </div>
    </section>
  );
}

export function SkillPointDetail({ point, onBack }: { point: SkillPoint; onBack: () => void }) {
  const Icon = point.icon;
  return (
    <div className="max-w-4xl space-y-8 px-6 py-5">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />功能市场
      </Button>

      <header className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-human text-lg font-semibold text-[var(--ink)]">
            <Icon className="h-5 w-5 shrink-0 text-[var(--muted)]" strokeWidth={1.75} aria-hidden />
            {point.name}
          </h2>
          <p className="mt-2 max-w-[52ch] text-pretty text-base leading-relaxed text-[var(--ink-2)]">{point.promise}</p>
          <ul className="mt-4 space-y-1.5 text-sm leading-relaxed text-[var(--ink-2)]" aria-label="小芽会这样做">
            {point.special.map(line => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--primary)]" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden h-[132px] w-[200px] shrink-0 items-center justify-center rounded-lg bg-[var(--inset)] sm:flex">
          <Specimen kind={point.specimen} className="h-[100px] w-[160px]" />
        </div>
      </header>

      <HowToUse point={point} />
      {point.results && <SkillResults kind={point.results} />}
    </div>
  );
}
