/**
 * 同一个对象在对话里只长一份（一个对象，多处可处理；对话里不重复刷卡）。
 * 后台每更新一次、小芽每查一次都会多一次工具调用，但它们说的是同一个东西：岗位清单就是岗位清单，
 * 某家的公司卡就是那一家。只让最后那次调用出卡，前面的不再出（2026-11-02：改完简历后「岗位清单」连着刷了一屏）。
 */
import { useMemo } from 'react';

import { unwrapCareerTool } from '@/components/tools/careerToolLabels';
import { useCareerCards } from '@/context/CareerCardsContext';
import type { Message, ToolUseSimple } from '@/types/chat';

import { inputOf, isInfoCardTool } from './cardContent';

const str = (v: unknown) => (typeof v === 'string' && v ? v : '');

/** 这次调用出的卡说的是哪个对象；null = 每次都是新东西（导出的文件），不合并。 */
export function infoCardKey(tool: ToolUseSimple): string | null {
  const bare = tool.name.replace(/^mcp__career__/, '');
  const input = inputOf(tool);
  switch (bare) {
    case 'jobs_board': case 'jobs_sync': return 'jobs';
    case 'deadline_add': case 'deadline_done': return `deadline:${str(input.deadline_id) || str(input.title) || tool.id}`;
    case 'resume_export': return null;
    default: return `${bare}:${str(input.job_id) || str(input.company_name) || str(input.company) || str(input.url) || tool.id}`;
  }
}

/** 对话里被后来的同一对象顶掉的工具调用 id。 */
export function supersededInfoCards(messages: readonly Message[]): Set<string> {
  const last = new Map<string, string>();
  const all: Array<[string, string]> = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if ((b.type !== 'tool_use' && b.type !== 'server_tool_use') || !b.tool) continue;
      const tool = unwrapCareerTool(b.tool);
      if (!isInfoCardTool(tool.name)) continue;
      const key = infoCardKey(tool);
      if (!key) continue;
      last.set(key, tool.id);
      all.push([key, tool.id]);
    }
  }
  return new Set(all.filter(([key, id]) => last.get(key) !== id).map(([, id]) => id));
}

/**
 * TabProvider 里算：消息每个 token 都在变，集合内容却很少变——按内容（排序后的 id 串）记忆，
 * 内容没变就是同一个 Set，卡片 Context 不跟着变，对话里的消息不会因为流式输出全体重渲染。
 */
export function useSupersededInfoCardsOf(messages: readonly Message[]): ReadonlySet<string> {
  const key = useMemo(() => [...supersededInfoCards(messages)].sort().join('\n'), [messages]);
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

const NONE: ReadonlySet<string> = new Set();

/** 消息里读：经卡片 Context 拿，不读 TabContext（见上）。 */
export function useSupersededInfoCards(): ReadonlySet<string> {
  return useCareerCards().supersededTools ?? NONE;
}
