/**
 * 挂在一次回复下面的工作面工具卡：这组内容块里每个属于工作面的工具调用，各出一张收起态卡片。
 */
import { BrowserWorkCard } from '@/components/career/BrowserWorkCard';
import type { CareerProgressEvent } from '@/components/career/types';
import type { ToolUseSimple } from '@/types/chat';

import { surfaceToolsIn, WorkSurfaceCard } from './workSurfaces';
import { useWorkSurfaces } from './workSurfaceStore';

export function MessageSurfaceCards({ tools }: { tools: readonly (ToolUseSimple | undefined)[] }) {
  const { takeover, runs } = useWorkSurfaces();
  const entries = surfaceToolsIn(tools);
  if (entries.length === 0) return null;
  const latestRun = runs[0];
  const progress: CareerProgressEvent | null = latestRun
    ? { phase: latestRun.steps[latestRun.steps.length - 1]?.phase ?? '', message: latestRun.steps[latestRun.steps.length - 1]?.message ?? '', progress: latestRun.progress ?? undefined }
    : null;
  return (
    <div data-testid="career-surface-cards" className="space-y-2 px-1 py-1">
      {entries.map(({ surface, tool }) => (surface === 'browser'
        ? <BrowserWorkCard key={tool.id} tool={tool} takeover={takeover} progress={progress} />
        : <WorkSurfaceCard key={tool.id} surface={surface} tool={tool} />))}
    </div>
  );
}
