/**
 * 功能市场：顶部是能直接打开的工具（Offer 对比、漏斗复盘、调研），下面是能力地图
 * （投递 / 面试 / 素材三条回路 + 复盘），每张卡一句"它帮你做什么"、"怎么触发"，
 * 以及一个真的会把话发进对话的按钮。用 onboarding 清单标出已经用过的能力。
 */
import { ArrowRight } from 'lucide-react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { Badge, Button, CareerPage, ChatActionButton, SectionTitle } from '@/components/career/CareerPrimitives';
import type { CareerFocusEvent, OnboardingChecklist } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation, type NavTarget } from '@/features/career-shell/navModel';

const ONBOARDING_TABLES = ['experience', 'claim', 'resume_master', 'mail_account', 'job', 'application', 'material'] as const;

interface Capability {
  name: string;
  what: string;
  how: string;
  /** 一句可以直接发给助理的话；没有的能力是自动发生的，只说明在哪看。 */
  chat?: string;
  /** 用哪个 onboarding 字段判断"已用过"。 */
  usedKey?: keyof OnboardingChecklist;
}
interface Loop { key: string; title: string; summary: string; items: Capability[] }

const LOOPS: Loop[] = [
  {
    key: 'apply', title: '投递回路', summary: '从一条 JD 到一次投递，中间每一步都能叫助理做，提交永远先过你。',
    items: [
      { name: '丢 JD 进收件箱，评估值不值得投', what: '给出匹配度、缺口和建议，省掉逐条读 JD。', how: '收件箱粘贴，或直接把 JD 贴给助理。', chat: '帮我评估这个岗位，JD 是：', usedKey: 'has_job' },
      { name: '按岗位定制简历', what: '在主简历基础上针对 JD 改一版，改动可追溯。', how: '卷宗里点"定制简历"，或直接说。', chat: '用主简历针对这个岗位改一版', usedKey: 'has_master_resume' },
      { name: '写投递邮件并等你批准发送', what: '起草邮件、附上简历 PDF，进"待批准"后你点一下才发。', how: '卷宗或今日页的"批准并发送"。', chat: '帮我给这个岗位写投递邮件，附上简历 PDF', usedKey: 'has_application' },
      { name: '网申填表', what: '打开网申页逐项填写；登录、验证码、最终提交交还给你。', how: '说一句，浏览器状态条会显示进度。', chat: '帮我准备这个岗位的网申', usedKey: 'has_application' },
      { name: '静默超时自动提醒关闭', what: '投出去没回音超过阈值，自动出现在今日页，你决定关闭还是再等。', how: '自动发生，不用设置。' },
    ],
  },
  {
    key: 'interview', title: '面试回路', summary: '邀请自动进卷宗，面试前一键摊开，面后复盘回写。',
    items: [
      { name: '面试邀请自动进卷宗', what: '绑定邮箱后，邀请邮件里的时间地点自动落到卷宗和截止。', how: '收件箱绑定邮箱即可。', usedKey: 'has_mail_account' },
      { name: '面试前一键摊开卷宗', what: '岗位、你投的简历版本、聊过的话、预测追问放在一页。', how: '卷宗页点公司，或直接说。', chat: '把某某公司的卷宗摊开，我明天面试' },
      { name: '预测追问', what: '按这家公司和你的简历，列出最可能被深挖的点。', how: '卷宗里"预测追问"，或直接说。', chat: '预测一下这家公司会深挖我简历哪里' },
      { name: '模拟面试', what: '按轮次（HR / 一面 / 终面）陪你练，追问到底。', how: '直接说，面完会给反馈。', chat: '帮我模拟一场一面' },
      { name: '面后复盘回写', what: '把你记得的问题和回答写回卷宗，下一轮不重复踩坑。', how: '面完口述一段即可。', chat: '帮我复盘刚才的面试' },
    ],
  },
  {
    key: 'material', title: '素材回路', summary: '经历 → 主张 → 主简历 → 开放题答案，一处确认处处一致。',
    items: [
      { name: '经历库与主张确认', what: '把口述的实习 / 项目拆成可验证的主张，你确认后才会写进简历。', how: '素材页，或直接口述。', chat: '帮我整理经历，我先口述一段实习', usedKey: 'has_experience' },
      { name: '主简历', what: '基于确认过的主张生成一份主简历，之后所有定制版都从它出发。', how: '素材页"生成主简历"。', chat: '帮我生成主简历', usedKey: 'has_master_resume' },
      { name: '开放题答案库与一致性', what: '"为什么选我们"这类题按公司生成并存档，前后口径不冲突。', how: '直接说，写完会存进素材页。', chat: "帮我写'为什么选择我们'，300 字，给某某公司", usedKey: 'has_material' },
      { name: '自我介绍三个长度', what: '30 秒 / 1 分钟 / 3 分钟三个版本，面试前随时取用。', how: '直接说。', chat: '给我一分钟和三分钟两个版本的自我介绍', usedKey: 'has_material' },
    ],
  },
  {
    key: 'review', title: '复盘', summary: '每周看一次漏斗就够了，剩下的时间别盯邮箱。',
    items: [
      { name: '每周漏斗与代理反馈', what: '投了多少、回了多少、卡在哪一环，和同类岗位的基准比。', how: '复盘页，或每周说一句。', chat: '给我做一次本周复盘' },
      { name: '方向探索', what: '从你的经历和市场反馈里找更合适的方向，而不是只盯一个岗位名。', how: '直接说。', chat: '帮我看看还有哪些方向适合我' },
      { name: '公司调研', what: '业务、口碑、近况、面试风格，投之前先看一眼。', how: '直接说公司名。', chat: '帮我查查这家公司靠不靠谱' },
    ],
  },
];

/** 能直接打开的工具页；目标与二级导航共用同一套 NavTarget。 */
const TOOLS: Array<{ name: string; what: string; target: NavTarget }> = [
  { name: 'Offer 对比', what: '把拿到的 Offer 放在一起，薪资、城市、成长一项项比。', target: { kind: 'career-dossier', view: 'offer' } },
  { name: '求职漏斗与周复盘', what: '投了多少、回了多少、卡在哪一环，每周看一次就够。', target: { kind: 'career-review', view: 'funnel' } },
  { name: '公司调研与方向', what: '投之前查查这家公司，也看看还有哪些方向适合你。', target: { kind: 'career-review', view: 'research' } },
];

const NEVER_DO = [
  { label: '登录', why: '账号是你的，密码不经过助理。' },
  { label: '验证码', why: '遇到就暂停，交回给你。' },
  { label: '测评作答', why: '必须本人完成，助理只帮你准备。' },
  { label: '最终提交与发送', why: '网申提交、邮件发送都要你批准。' },
];

const START_STEPS: Array<{ title: string; detail: string; surface: CareerFocusEvent['surface']; button: string }> = [
  { title: '把经历放进来', detail: '口述一段实习或项目，确认主张，生成主简历。', surface: 'material', button: '去素材' },
  { title: '绑邮箱、丢第一个 JD', detail: '邀请和拒信自动进来；JD 丢进去就有评估。', surface: 'inbox', button: '去收件箱' },
  { title: '每天只看今日', detail: '最多三件事，其余都在等待，不用天天刷邮箱。', surface: 'today', button: '去今日' },
];

function isUsed(c: OnboardingChecklist | null, key?: keyof OnboardingChecklist): boolean {
  if (!c || !key) return false;
  if (key === 'has_experience') return Boolean(c.has_experience || c.has_confirmed_claim);
  return Boolean(c[key]);
}

export default function CareerGuide({ embedded = false }: CareerPageProps) {
  const onboarding = useCareerQuery(careerApi.onboarding, ONBOARDING_TABLES);
  const used = (key?: keyof OnboardingChecklist) => isUsed(onboarding.data, key);

  return (
    <CareerPage embedded={embedded} title="功能市场" subtitle="想做什么，挑一个交给小芽" examples={['帮我评估这个岗位', '帮我模拟一场一面', '给我做一次本周复盘']}>
      <div className="max-w-6xl space-y-10 px-6 py-6">
        <section>
          <SectionTitle>工具</SectionTitle>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-3">
            {TOOLS.map(tool => (
              <button
                key={tool.name}
                type="button"
                onClick={() => requestNavigation(tool.target)}
                className="group -mx-3 flex flex-col items-start rounded-lg px-3 py-3 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <span className="font-human text-base font-semibold text-[var(--ink)]">{tool.name}</span>
                <span className="mt-1 text-sm text-[var(--muted)]">{tool.what}</span>
                <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-[var(--primary)]">打开<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle>怎么开始</SectionTitle>
          <ol className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3">
            {START_STEPS.map((step, idx) => (
              <li key={step.surface} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--hard)] font-human text-sm text-[var(--ink)]">{idx + 1}</span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--ink)]">{step.title}</div>
                  <div className="mt-0.5 text-sm text-[var(--muted)]">{step.detail}</div>
                  <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={() => emitEvent('career:focus', { surface: step.surface } satisfies CareerFocusEvent)}>{step.button}</Button>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {LOOPS.map(loop => (
          <section key={loop.key} className="border-t border-[var(--line)] pt-6">
            <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-human text-lg font-semibold text-[var(--ink)]">{loop.title}</h2>
              <span className="text-sm text-[var(--muted)]">{loop.summary}</span>
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
              {loop.items.map(cap => (
                <div key={cap.name} className="flex flex-col">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-[var(--ink)]">{cap.name}</span>
                    {used(cap.usedKey) ? <Badge tone="success">已用过</Badge> : cap.chat ? null : <Badge tone="neutral">自动</Badge>}
                  </div>
                  <div className="mt-1 text-sm text-[var(--ink-2)]">{cap.what}</div>
                  <div className="mt-0.5 text-xs text-[var(--muted)]">怎么触发：{cap.how}</div>
                  {cap.chat && (
                    <ChatActionButton text={cap.chat} context={{ surface: 'guide', note: `指南 · ${loop.title} · ${cap.name}` }} variant="ghost" size="sm" className="-ml-3 mt-1 self-start">试试：「{cap.chat}」</ChatActionButton>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="border-t border-[var(--line)] pt-6">
          <h2 className="mb-3 font-human text-lg font-semibold text-[var(--ink)]">助理永远不会替你做的事</h2>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
            {NEVER_DO.map(n => (
              <li key={n.label} className="flex items-start gap-3 text-sm">
                <span className="w-28 shrink-0 font-medium text-[var(--ink)]">{n.label}</span>
                <span className="text-[var(--muted)]">{n.why}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </CareerPage>
  );
}
