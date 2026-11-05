/**
 * 接管简报（Intelligent UI 规范 5.11）：接管卡的完整版。
 * 先说替你接管了几家，再放现在要你的事（最急一件 lg 海报 + 期限大字），然后是阶段判断（依据写出来，点一下能改，选中用墨色）、
 * 按阶段排开的申请（小签；已结束只写数字、名单收起）、没认出的邮件。准备期没东西可接管时，改写阶段与下一步。
 * 数据来自服务端 mail/takeover.ts。
 */
import { useEffect, useRef, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { Button, CareerPage, ChatActionButton, DueLabel, ErrorRow, LoadingRow, suggestToChat } from '@/components/career/CareerPrimitives';
import { UrgentNeed, companyOf, openApplication } from '@/components/career/ColdStartCards';
import { CompanyTag, CountTag } from '@/components/career/CompanyMark';
import { MailConnectCenter } from '@/components/career/mail-connect/MailConnectCenter';
import type { SeasonId, TakeoverBriefing } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation } from '@/features/career-shell/navModel';
import { takeCareerFocus } from '@/features/career-shell/pendingFocus';

const TABLES = ['mail_account', 'mail_message', 'application', 'deadline'] as const;
/** 每一列最多列几家，其余折成「+N」。 */
const BUCKET_SHOWN = 8;
const UNCLASSIFIED_SHOWN = 5;
/** 招聘窗口（世界模型第 2 节，往年规律）：春招 3～4 月、提前批 7～8 月、秋招正式批 9～11 月。 */
const WINDOWS = [{ name: '春招', from: 3, to: 4 }, { name: '提前批', from: 7, to: 8 }, { name: '秋招正式批', from: 9, to: 11 }] as const;

const day = (iso: string | null) => (iso ? `${new Date(iso).getMonth() + 1} 月 ${new Date(iso).getDate()} 日` : '');
const H3 = ({ id, children }: { id: string; children: string }) => <h3 id={id} className="text-xs font-medium text-[var(--muted)]">{children}</h3>;

export default function CareerTakeover({ embedded = false, onOpenChat }: CareerPageProps) {
  const [accountId] = useState(() => takeCareerFocus('takeover')?.id ?? null);
  const q = useCareerQuery(() => careerApi.takeover(accountId), TABLES);
  const b = q.data;
  const viewed = useRef(false);
  useEffect(() => {
    if (!b || viewed.current || b.report.viewed_at) return;
    viewed.current = true;
    void careerApi.markTakeoverViewed(b.report.account_id).catch(error => console.warn('[career-takeover] 标记已看失败:', error));
  }, [b]);

  return (
    <CareerPage embedded={embedded} title="接管简报">
      <div className="mx-auto grid max-w-[880px] gap-8 px-6 py-6">
        {q.loading && !q.data && <LoadingRow />}
        {q.error && <ErrorRow message={q.error} onRetry={q.reload} />}
        {!q.loading && !b && !q.error && (
          <section className="grid gap-3">
            <p className="text-sm text-[var(--ink)]">连上邮箱，替你整理近半年的求职邮件</p>
            <MailConnectCenter />
          </section>
        )}
        {b && b.applications > 0 && <Briefing b={b} />}
        {b && b.applications === 0 && <PrepBriefing b={b} onOpenChat={onOpenChat} />}
      </div>
    </CareerPage>
  );
}

function Briefing({ b }: { b: TakeoverBriefing }) {
  const { report } = b;
  return (
    <>
      <header className="grid gap-1">
        <h2 className="font-human text-2xl font-semibold text-[var(--ink)]">替你接管了 {b.applications} 家公司的申请</h2>
        <p className="text-sm text-[var(--muted)]">
          来自 {report.address}{report.span.from ? ` ${day(report.span.from)}～${day(report.span.to)}` : ''} 的 {report.mails} 封求职邮件
        </p>
      </header>
      <NeedsYou b={b} />
      <SeasonRow season={b.season} seasons={b.seasons} />
      <Buckets buckets={b.buckets} />
      <Unclassified items={b.unclassified} />
    </>
  );
}

function NeedsYou({ b }: { b: TakeoverBriefing }) {
  const [first, ...rest] = b.needs;
  return (
    <section aria-labelledby="takeover-needs" className="grid gap-2">
      <H3 id="takeover-needs">现在要你的事</H3>
      {!first && <p className="text-sm text-[var(--ink-2)]">暂时没有要你处理的。</p>}
      {first && (
        <button type="button" onClick={() => openApplication(first.application_id)} className="rounded-[10px] text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]">
          <UrgentNeed b={b} />
        </button>
      )}
      <ul className="grid gap-2">
        {rest.map(n => (
          <li key={n.deadline_id}>
            <button type="button" onClick={() => openApplication(n.application_id)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]">
              <CompanyTag name={companyOf(b, n.application_id) ?? '—'} />
              <span className="min-w-0 flex-1 text-sm text-[var(--ink)]">{n.title}</span>
              {n.due_at ? <DueLabel at={n.due_at} suffix="" /> : <span className="text-xs text-[var(--muted)]">时间待确认</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeasonRow({ season, seasons }: { season: TakeoverBriefing['season']; seasons: TakeoverBriefing['seasons'] }) {
  const [current, setCurrent] = useState(season);
  const act = useCareerAction();
  const pick = (id: SeasonId) => act.run(async () => setCurrent(await careerApi.setSeason(id)));
  return (
    <section aria-labelledby="takeover-season" className="grid gap-2">
      <H3 id="takeover-season">你现在大概在</H3>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-human text-lg font-semibold text-[var(--ink)]">{current.label}</span>
        <span className="text-xs text-[var(--subtle)]">{current.source === 'user' ? '你选的' : `依据：${current.basis}`}</span>
      </div>
      <div role="radiogroup" aria-label="改一下阶段" className="flex flex-wrap gap-1.5">
        {seasons.map(s => (
          <button key={s.id} type="button" role="radio" aria-checked={s.id === current.id} disabled={act.busy} onClick={() => void pick(s.id)}
            className={`rounded-full border px-3 py-0.5 text-xs ${s.id === current.id ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--bg)]' : 'border-[var(--line-2)] text-[var(--ink-2)] hover:bg-[var(--hover)]'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </section>
  );
}

function Buckets({ buckets }: { buckets: TakeoverBriefing['buckets'] }) {
  const [showClosed, setShowClosed] = useState(false);
  return (
    <section aria-labelledby="takeover-apps" className="grid gap-2">
      <H3 id="takeover-apps">接管的申请</H3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {buckets.map(bk => {
          const closed = bk.id === 'closed';
          return (
            <div key={bk.id} className="min-w-0">
              <div className={`flex items-baseline gap-2 border-b border-[var(--line)] pb-1 ${closed ? 'text-[var(--muted)]' : 'text-[var(--ink)]'}`}>
                <span className="text-sm">{bk.label}</span>
                <span className="text-2xl font-semibold tabular-nums">{bk.items.length}</span>
              </div>
              {/* 拒信只计数（规范 5.6）：已结束的名单收起来，点开才看，且变淡 */}
              {closed && bk.items.length > 0 && (
                <button type="button" aria-expanded={showClosed} onClick={() => setShowClosed(v => !v)} className="mt-1.5 text-xs text-[var(--subtle)] underline underline-offset-2">
                  {showClosed ? '收起' : '看名单'}
                </button>
              )}
              {(!closed || showClosed) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {bk.items.slice(0, BUCKET_SHOWN).map(it => (
                    <button key={it.application_id} type="button" onClick={() => openApplication(it.application_id)} aria-label={`${it.company ?? it.title} · ${it.title}`}>
                      <CompanyTag name={it.company ?? it.title} faded={closed} />
                    </button>
                  ))}
                  {bk.items.length > BUCKET_SHOWN && <CountTag n={bk.items.length - BUCKET_SHOWN} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => requestNavigation({ kind: 'career-dossier', view: 'line' })}>看全部投递记录</Button>
    </section>
  );
}

function Unclassified({ items }: { items: TakeoverBriefing['unclassified'] }) {
  if (!items.length) return null;
  const subjects = items.slice(0, UNCLASSIFIED_SHOWN).map(u => u.subject ?? '(无主题)');
  return (
    <section aria-labelledby="takeover-unknown" className="grid gap-2 border-t border-[var(--line)] pt-4">
      <H3 id="takeover-unknown">{`没认出来的 ${items.length} 封`}</H3>
      <ul className="grid gap-1 text-sm text-[var(--subtle)]">
        {subjects.map((s, i) => <li key={i} className="truncate">{s}</li>)}
      </ul>
      <ChatActionButton variant="secondary" className="justify-self-start" text={`帮我看看这几封没认出来的求职邮件：${subjects.join('；')}`} context={{ surface: 'inbox', note: '接管简报里没认出的历史邮件' }}>交给助理看看</ChatActionButton>
    </section>
  );
}

/** 下一个招聘窗口：正在窗口里就说正在进行，否则说离现在大约几个月（往年规律）。 */
export function nextWindow(now = new Date()): string {
  const m = now.getMonth() + 1;
  const inside = WINDOWS.find(w => m >= w.from && m <= w.to);
  if (inside) return `${inside.name}往年 ${inside.from}～${inside.to} 月，现在正是时候`;
  const next = WINDOWS.find(w => w.from > m) ?? WINDOWS[0];
  const months = (next.from - m + 12) % 12;
  return `${next.name}往年多在 ${next.from}～${next.to} 月开，离现在大约 ${months} 个月`;
}

/** 准备期：没东西可接管，不写空白，写阶段与下一步（规范 5.11）。全页没有钢笔蓝：没有要你动手的事。 */
function PrepBriefing({ b, onOpenChat }: { b: TakeoverBriefing; onOpenChat: () => void }) {
  const onboarding = useCareerQuery(careerApi.onboarding, ['experience', 'mail_account']);
  const emptyExperience = onboarding.data ? !onboarding.data.has_experience : false;
  return (
    <>
      <header className="grid gap-1">
        <h2 className="font-human text-2xl font-semibold text-[var(--ink)]">{b.season.id === 'prep' ? '你还在准备期，邮箱里还没有求职邮件' : '邮箱连好了，还没有求职邮件'}</h2>
      </header>
      <SeasonRow season={b.season} seasons={b.seasons} />
      <section aria-labelledby="takeover-next" className="grid gap-2">
        <H3 id="takeover-next">接下来</H3>
        <div className="grid gap-2 text-sm text-[var(--ink-2)]">
          <p>{nextWindow()}</p>
          {emptyExperience && <p>经历库还是空的。</p>}
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onOpenChat}>去对话里拖简历</Button>
          <Button variant="ghost" onClick={() => suggestToChat('我做过一件事：', { surface: 'today' }, 'prefill')}>说一件做过的事</Button>
        </div>
      </section>
    </>
  );
}
