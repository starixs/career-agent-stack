/**
 * 挂在一次回复下面的打破式卡片：
 *  - 属于工作面的工具调用（改简历 / 模拟面试 / 笔试），各出一张能在右侧展开的卡片；
 *    浏览器不在对话里出卡：网申现场和等你都在右栏（主线体验 §6.6 三选一）。2026-11-02 真网站实测：
 *    每次 apply_* 调用各挂一张，几张读的是同一个全局交接状态，对话里堆出一串一模一样、不写哪家的「浏览器」卡；
 *  - 公司 / 岗位、岗位清单、截止日程、导出文件这类结果，出一张信息卡，点了去对应页面；
 *    同一个对象后来又出了一次，前面那张就不再出（supersede.ts）。
 */
import type { ToolUseSimple } from '@/types/chat';

import { BreakoutCard } from './BreakoutCard';
import { infoCardFor, isInfoCardTool } from './cardContent';
import { requestNavigation } from './navModel';
import { useSupersededInfoCards } from './supersede';
import { surfaceToolsIn, WorkSurfaceCard } from './workSurfaces';

export function MessageSurfaceCards({ tools }: { tools: readonly (ToolUseSimple | undefined)[] }) {
  const entries = surfaceToolsIn(tools).flatMap(({ surface, tool }) => (surface === 'browser' ? [] : [{ surface, tool }]));
  const superseded = useSupersededInfoCards();
  const infos = tools.flatMap(tool => {
    if (!tool || !isInfoCardTool(tool.name) || superseded.has(tool.id)) return [];
    const spec = infoCardFor(tool);
    return spec ? [{ tool, spec }] : [];
  });
  if (entries.length === 0 && infos.length === 0) return null;
  return (
    <div data-testid="career-surface-cards" className="space-y-2 px-1 py-1">
      {entries.map(({ surface, tool }) => <WorkSurfaceCard key={tool.id} surface={surface} tool={tool} />)}
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
