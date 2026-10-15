/**
 * 功能市场（2026-10-13 会议定）：照 Codex 插件市场的样式，一行两个工具，点了直接用，没有「添加」按钮。
 * - 大功能有自己的工作台（面试、笔试、简历），点了跳过去；
 * - 小功能跳到对话，把一句话预填进输入框，可以直接发，也可以先改；
 * - 原来的教程挪进下面的「点子」，一行一个，先统一展示，以后再按用户情况推荐。
 */
import {
  BarChart3, Building2, ChevronRight, Compass, Crosshair, FileText, History, Library, Mail, MessageSquareQuote, Mic, PenLine, Scale, Send, Target, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { requestAssistFilter } from '@/components/career/AssistRecords';
import { CareerPage, SectionTitle, suggestToChat } from '@/components/career/CareerPrimitives';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation, type NavTarget } from '@/features/career-shell/navModel';

/** 点了做什么：去一个页面，或把一句话预填进对话输入框。 */
type MarketAction = { open: NavTarget; before?: () => void } | { prefill: string };

export interface MarketItem { name: string; what: string; icon: LucideIcon; action: MarketAction }

export const WORKBENCHES: MarketItem[] = [
  { name: '面试助力', what: '面试记录、题库刷题、模拟面试和深挖点预测都在这里', icon: Users, action: { open: { kind: 'career-dossier', view: 'interview' } } },
  { name: '笔试助力', what: '收到的笔试、测评都在一张表里，点「助力」交给小芽', icon: PenLine, action: { open: { kind: 'career-dossier', view: 'assist' }, before: () => requestAssistFilter('exam') } },
  { name: '简历编辑', what: '直接看成品，哪里不对说一句就改', icon: FileText, action: { open: { kind: 'career-material', view: 'resume' } } },
  { name: '题库刷题', what: '挑一个题库练，答完给你点评', icon: Library, action: { open: { kind: 'career-dossier', view: 'interview' } } },
  { name: 'Offer 对比', what: '薪资、城市、成长一项项比', icon: Scale, action: { open: { kind: 'career-dossier', view: 'offer' } } },
  { name: '求职漏斗与复盘', what: '投了多少、回了多少、卡在哪一环', icon: BarChart3, action: { open: { kind: 'career-review', view: 'funnel' } } },
  { name: '公司调研与方向', what: '投之前查查这家公司，也看看还有哪些方向', icon: Building2, action: { open: { kind: 'career-review', view: 'research' } } },
];

export const CHAT_TOOLS: MarketItem[] = [
  { name: '网申助手', what: '打开网申页逐项填写，登录和最终提交交给你', icon: Send, action: { prefill: '帮我准备这个岗位的网申，链接是：' } },
  { name: '岗位评估', what: '贴一段 JD，看匹配度、缺口和值不值得投', icon: Target, action: { prefill: '帮我评估这个岗位，JD 是：' } },
  { name: '投递邮件', what: '起草邮件、附上简历，你批准了才发', icon: Mail, action: { prefill: '帮我给这个岗位写投递邮件，附上简历 PDF' } },
  { name: '开放题答案', what: '「为什么选我们」这类题按公司写，前后口径一致', icon: MessageSquareQuote, action: { prefill: '帮我写「为什么选择我们」，300 字，给这家公司：' } },
  { name: '自我介绍', what: '一分钟、三分钟两个版本，面试前随时取用', icon: Mic, action: { prefill: '给我一分钟和三分钟两个版本的自我介绍' } },
  { name: '预测追问', what: '这家公司最可能深挖你简历的哪几处', icon: Crosshair, action: { prefill: '预测一下这家公司会深挖我简历哪里：' } },
  { name: '面后复盘', what: '口述一遍刚才的面试，下一轮不再踩坑', icon: History, action: { prefill: '帮我复盘刚才的面试：' } },
  { name: '方向探索', what: '从你的经历和反馈里找更合适的方向', icon: Compass, action: { prefill: '帮我看看还有哪些方向适合我' } },
];

export interface Idea { text: string; button: string; action: MarketAction }

export const IDEAS: Idea[] = [
  { text: '刚开始用？先口述一段实习或项目，小芽帮你写进简历。', button: '口述一段', action: { prefill: '我先口述一段实习，帮我整理进简历：' } },
  { text: '丢一个 JD 进来，先看看值不值得投。', button: '评估岗位', action: { prefill: '帮我评估这个岗位，JD 是：' } },
  { text: '绑定邮箱，面试邀请、笔试和拒信自动进来，不用天天刷。', button: '去绑定', action: { open: { kind: 'career-vault' } } },
  { text: '投出去两周没动静？让小芽看看哪些线可以关掉，把精力留给别处。', button: '看看', action: { prefill: '帮我看看哪些投递很久没动静了，哪些可以关掉' } },
  { text: '明天面试？一句话摊开卷宗：投的哪版简历、对这家说过什么。', button: '摊开卷宗', action: { prefill: '我明天面试，把这家公司的卷宗摊开：' } },
  { text: '每周看一次漏斗就够了：投了多少、卡在哪一环。', button: '做一次复盘', action: { prefill: '给我做一次本周复盘' } },
];

export function runMarketAction(action: MarketAction, note: string): void {
  if ('prefill' in action) {
    suggestToChat(action.prefill, { surface: 'guide', note }, 'prefill');
    return;
  }
  action.before?.();
  requestNavigation(action.open);
}

function ToolGrid({ items }: { items: MarketItem[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => runMarketAction(item.action, `功能市场 · ${item.name}`)}
              className="group -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]">
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--ink)]">{item.name}</span>
                <span className="block truncate text-xs text-[var(--muted)]">{item.what}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--subtle)] transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  return (
    <CareerPage embedded={embedded} title="功能市场" subtitle="想做什么，点一下就用">
      <div className="max-w-4xl space-y-10 px-6 py-6">
        <section>
          <SectionTitle>工作台</SectionTitle>
          <ToolGrid items={WORKBENCHES} />
        </section>
        <section>
          <SectionTitle>交给小芽</SectionTitle>
          <ToolGrid items={CHAT_TOOLS} />
        </section>
        <section>
          <SectionTitle>点子</SectionTitle>
          <ul className="space-y-2">
            {IDEAS.map(idea => (
              <li key={idea.text} className="flex items-center gap-4 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                <span className="min-w-0 flex-1 text-sm text-[var(--ink)]">{idea.text}</span>
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
