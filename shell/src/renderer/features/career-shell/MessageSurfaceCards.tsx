/**
 * 挂在一次回复下面的打破式卡片：
 *  - 属于工作面的工具调用（浏览器 / 改简历 / 模拟面试 / 笔试），各出一张能在右侧展开的卡片；
 *  - 公司 / 岗位、岗位清单、截止日程、导出文件这类结果，出一张信息卡，点了去对应页面。
 */
import { BrowserWorkCard } from '@/components/career/BrowserWorkCard';
import type { CareerProgressEvent } from '@/components/career/types';
import type { ToolUseSimple } from '@/types/chat';

import { BreakoutCard } from './BreakoutCard';
import { infoCardFor, isInfoCardTool } from './cardContent';
import { requestNavigation } from './navModel';
import { surfaceToolsIn, WorkSurfaceCard } from './workSurfaces';
import { useWorkSurfaces } from './workSurfaceStore';

export function MessageSurfaceCards({ tools }: { tools: readonly (ToolUseSimple | undefined)[] }) {
  const { takeover, runs } = useWorkSurfaces();
  const entries = surfaceToolsIn(tools);
  const infos = tools.flatMap(tool => {
    if (!tool || !isInfoCardTool(tool.name)) return [];
    const spec = infoCardFor(tool);
    return spec ? [{ tool, spec }] : [];
  });
  if (entries.length === 0 && infos.length === 0) return null;
  const latestRun = runs[0];
  const lastStep = latestRun?.steps[latestRun.steps.length - 1];
  const progress: CareerProgressEvent | null = latestRun
    ? { phase: lastStep?.phase ?? '', message: lastStep?.message ?? '', progress: latestRun.progress ?? undefined }
    : null;
  return (
    <div data-testid="career-surface-cards" className="space-y-2 px-1 py-1">
      {entries.map(({ surface, tool }) => (surface === 'browser'
        ? <BrowserWorkCard key={tool.id} tool={tool} takeover={takeover} progress={progress} />
        : <WorkSurfaceCard key={tool.id} surface={surface} tool={tool} />))}
      {infos.map(({ tool, spec }) => (
        <BreakoutCard
          key={tool.id}
          testId={`career-info-card-${tool.name.replace(/^mcp__career__/, '')}`}
          anchor={spec.content.anchor}
          title={spec.content.title}
          aside={spec.content.aside}
          overline={spec.content.overline}
          rows={spec.content.rows}
          status={{ tone: 'idle', text: spec.status }}
          action={{ label: spec.openLabel, onOpen: () => requestNavigation(spec.target) }}
        >
          {spec.content.body}
        </BreakoutCard>
      ))}
    </div>
  );
}
