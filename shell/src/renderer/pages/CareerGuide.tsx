/**
 * 功能市场（2026-10-13 会议定，2026-11-05 第 3 轮打磨）：点了直接用，没有「添加」按钮。
 * - 大功能有自己的工作台（面试、笔试、简历），点了跳过去；小功能回对话起头（整句直接发，带冒号的预填）；
 * - 按任务分组（找岗位与投递 / 简历与材料 / 笔试面试 / 复盘与选择），不按「跳页还是对话」分；
 * - 裸图标 + 名字 + 一句说明，一行 48，三列；点子是无框列表。
 */
import {
  BarChart3, Building2, ClipboardList, Compass, Crosshair, FileText, History, Inbox, Layers, Mail, MessageSquareQuote, MessagesSquare, Mic,
  NotebookPen, PenLine, Scale, Send, Smartphone, Target, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { CareerPage, SectionTitle } from '@/components/career/CareerPrimitives';
import { runFeatureStart } from '@/components/career/runFeatureStart';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

import { FEATURE_IDEAS, FEATURES, featuresInGroup, resolveFeatureStart, type CareerFeature, type FeatureIcon, type FeatureId, type FeatureStart } from '../../shared/careerFeatures';

/** 功能清单只有一份（shared/careerFeatures.ts）；图标名在这里映射成组件。 */
const ICONS: Record<FeatureIcon, LucideIcon> = {
  Users, PenLine, FileText, Scale, BarChart3, Building2, Layers, Send, Target, Mail, MessageSquareQuote, Mic, Crosshair, History, Compass,
  Smartphone, Inbox, NotebookPen, ClipboardList, MessagesSquare,
};

/** 点了做什么：open 打开一页；prefill 在输入框预填一句；batch 回对话让小芽放一张批量勾选表。 */
type MarketAction = FeatureStart;

export interface MarketItem { id: FeatureId; name: string; what: string; icon: LucideIcon; action: MarketAction }

const toItem = (f: CareerFeature): MarketItem => ({ id: f.id, name: f.name, what: f.what, icon: ICONS[f.icon], action: resolveFeatureStart(f.id) });

export const WORKBENCHES: MarketItem[] = featuresInGroup('workbench').map(toItem);
export const CHAT_TOOLS: MarketItem[] = featuresInGroup('chat').map(toItem);

/** 按任务分组；市场里有、这里没列到的功能落进最后一组，不会漏。 */
const TASK_LAYOUT: { title: string; ids: FeatureId[] }[] = [
  { title: '找岗位与投递', ids: ['batch', 'job_evaluate', 'company_research', 'live', 'mail_compose'] },
  { title: '简历与材料', ids: ['resume_editor', 'open_q', 'self_intro'] },
  { title: '笔试面试', ids: ['exam_search', 'interview', 'interview_predict', 'interview_retro'] },
  { title: '复盘与选择', ids: ['funnel', 'offer', 'direction_explore'] },
];

export const TASK_GROUPS: { title: string; items: MarketItem[] }[] = (() => {
  const market = [...WORKBENCHES, ...CHAT_TOOLS];
  const placed = new Set(TASK_LAYOUT.flatMap(g => g.ids));
  const groups = TASK_LAYOUT.map(g => ({
    title: g.title,
    items: g.ids.filter(id => FEATURES[id].group !== 'hidden').map(id => market.find(m => m.id === id)).filter((m): m is MarketItem => !!m),
  }));
  groups[groups.length - 1].items.push(...market.filter(m => !placed.has(m.id)));
  return groups.filter(g => g.items.length > 0);
})();

export interface Idea { text: string; button: string; action: MarketAction }

export const IDEAS: Idea[] = FEATURE_IDEAS.map(i => ({ text: i.text, button: i.button, action: i.start }));

/** 市场卡和建议条的起头格走同一个执行器（runFeatureStart）。 */
export const runMarketAction = runFeatureStart;

function ToolGrid({ items }: { items: MarketItem[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 md:grid-cols-2 lg:grid-cols-3">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => runMarketAction(item.action, `功能市场 · ${item.name}`)}
              className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
            >
              <Icon className="h-5 w-5 shrink-0 text-[var(--muted)]" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--ink)]">{item.name}</span>
                <span className="block truncate text-xs text-[var(--muted)]">{item.what}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  return (
    <CareerPage embedded={embedded} title="功能市场">
      <div className="max-w-[960px] space-y-8 px-6 py-6">
        {TASK_GROUPS.map(g => (
          <section key={g.title}>
            <SectionTitle>{g.title}</SectionTitle>
            <ToolGrid items={g.items} />
          </section>
        ))}
        <section>
          <SectionTitle>点子</SectionTitle>
          <ul>
            {IDEAS.map(idea => (
              <li key={idea.text} className="flex min-h-12 items-center gap-4 border-l-2 border-[var(--line)] pl-3">
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
        </section>
      </div>
    </CareerPage>
  );
}
