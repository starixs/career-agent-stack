/**
 * 接管简报（冷启动做法二）：第一次连邮箱、历史邮件收完后打开。
 * 先说替你接管了几家，再放现在要你的事（最急的在最前），然后是阶段判断（依据写出来，点一下能改）、
 * 按阶段排开的申请、没认出的邮件。数据来自服务端 mail/takeover.ts。
 */
import { useEffect, useRef, useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { Button, CareerPage, ChatActionButton, DueLabel, ErrorRow, LoadingRow } from '@/components/career/CareerPrimitives';
import { MailConnectCenter } from '@/components/career/mail-connect/MailConnectCenter';
import type { CareerFocusEvent, SeasonId, TakeoverBriefing } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { requestNavigation } from '@/features/career-shell/navModel';
import { takeCareerFocus } from '@/features/career-shell/pendingFocus';

const TABLES = ['mail_account', 'mail_message', 'application', 'deadline'] as const;
/** 每一列最多列几家，其余折成「还有 N 家」。 */
const BUCKET_SHOWN = 8;
const UNCLASSIFIED_SHOWN = 5;

const day = (iso: string | null) => (iso ? `${new Date(iso).getMonth() + 1} 月 ${new Date(iso).getDate()} 日` : '');

export default function CareerTakeover({ embedded = false }: CareerPageProps) {
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
    <CareerPage embedded={embedded} title="接管简报" subtitle={b ? `${b.report.address} · ${day(b.report.updated_at)}` : undefined}
      actions={<Button variant="ghost" size="sm" onClick={() => requestNavigation({ kind: 'career-today' })}>去招聘概览</Button>}>
      <div className="mx-auto grid max-w-[880px] gap-8 px-6 py-6">
        {q.loading && !q.data && <LoadingRow />}
        {q.error && <ErrorRow message={q.error} onRetry={q.reload} />}
        {!q.loading && !b && !q.error && (
          <section className="grid gap-3">
            <p className="text-sm text-[var(--muted)]">还没有接管简报。连上邮箱后，近半年的求职邮件收好了，这里会告诉你替你接管了什么。</p>
            <MailConnectCenter />
          </section>
        )}
        {b && <Briefing b={b} />}
      </div>
    </CareerPage>
  );
}

function Briefing({ b }: { b: TakeoverBriefing }) {
  const { report } = b;
  return (
    <>
      <header className="grid gap-1">
        <h2 className="font-human text-2xl font-semibold text-[var(--ink)]">
          {b.applications ? `替你接管了 ${b.applications} 家公司的申请` : '邮件收好了，还没认出能接管的申请'}
        </h2>
        <p className="text-sm text-[var(--muted)]">
          来自 {report.address}{report.span.from ? ` ${day(report.span.from)}～${day(report.span.to)}` : ''} 的 {report.mails} 封求职邮件。
          以后的新邮件也会自动识别，不用再手动导入。
        </p>
      </header>
      <NeedsYou needs={b.needs} />
      <SeasonRow season={b.season} seasons={b.seasons} />
      <Buckets buckets={b.buckets} />
      <Unclassified items={b.unclassified} />
    </>
  );
}

function openApplication(applicationId: string | null) {
  if (!applicationId) return;
  const event: CareerFocusEvent = { surface: 'dossier', application_id: applicationId };
  emitEvent('career:focus', event);
}

function NeedsYou({ needs }: { needs: TakeoverBriefing['needs'] }) {
  return (
    <section aria-labelledby="takeover-needs" className="grid gap-2">
      <h3 id="takeover-needs" className="text-xs font-medium text-[var(--muted)]">现在要你的事</h3>
      {!needs.length && <p className="text-sm text-[var(--ink-2)]">暂时没有要你马上处理的。笔试、面试、Offer 期限一到，会出现在招聘概览和通知中心。</p>}
      <ul className="grid gap-2">
        {needs.map((n, i) => (
          <li key={n.deadline_id}>
            <button type="button" onClick={() => openApplication(n.application_id)}
              className={`flex w-full items-center gap-3 rounded-[10px] px-4 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${i === 0 ? 'border-[1.5px] border-[var(--ink)] bg-[var(--paper)] py-3 shadow-[3px_3px_0_var(--ink)]' : 'border border-[var(--line)] py-2'}`}>
              <span className={`min-w-0 flex-1 ${i === 0 ? 'text-base font-semibold' : 'text-sm'} text-[var(--ink)]`}>{n.title}</span>
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
      <h3 id="takeover-season" className="text-xs font-medium text-[var(--muted)]">你现在大概在</h3>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-human text-lg font-semibold text-[var(--ink)]">{current.label}</span>
        <span className="text-xs text-[var(--subtle)]">{current.source === 'user' ? '你选的' : `依据：${current.basis}`}</span>
      </div>
      <div role="radiogroup" aria-label="改一下阶段" className="flex flex-wrap gap-1.5">
        {seasons.map(s => (
          <button key={s.id} type="button" role="radio" aria-checked={s.id === current.id} disabled={act.busy} onClick={() => void pick(s.id)}
            className={`rounded-full border px-3 py-0.5 text-xs ${s.id === current.id ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--on-primary)]' : 'border-[var(--line-2)] text-[var(--ink-2)] hover:bg-[var(--hover)]'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </section>
  );
}

function Buckets({ buckets }: { buckets: TakeoverBriefing['buckets'] }) {
  return (
    <section aria-labelledby="takeover-apps" className="grid gap-2">
      <h3 id="takeover-apps" className="text-xs font-medium text-[var(--muted)]">接管的申请</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {buckets.map(bk => (
          <div key={bk.id} className="min-w-0">
            <div className="flex items-baseline gap-2 border-b border-[var(--line)] pb-1">
              <span className="text-sm text-[var(--ink)]">{bk.label}</span>
              <span className="text-2xl font-semibold tabular-nums text-[var(--ink)]">{bk.items.length}</span>
            </div>
            <ul className="mt-2 grid gap-1">
              {bk.items.slice(0, BUCKET_SHOWN).map(it => (
                <li key={it.application_id}>
                  <button type="button" onClick={() => openApplication(it.application_id)} className="w-full truncate text-left text-sm text-[var(--ink-2)] hover:text-[var(--primary)]">
                    {it.company ?? it.title}
                  </button>
                </li>
              ))}
              {bk.items.length > BUCKET_SHOWN && <li className="text-xs text-[var(--subtle)]">还有 {bk.items.length - BUCKET_SHOWN} 家</li>}
            </ul>
          </div>
        ))}
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
      <h3 id="takeover-unknown" className="text-xs font-medium text-[var(--muted)]">没认出来的 {items.length} 封</h3>
      <p className="text-sm text-[var(--ink-2)]">看着像求职邮件，但认不出是哪家、到了哪一步。不管它也行，那家以后再来信会自动补上。</p>
      <ul className="grid gap-1 text-sm text-[var(--ink-2)]">
        {subjects.map((s, i) => <li key={i} className="truncate">{s}</li>)}
      </ul>
      <ChatActionButton variant="secondary" className="justify-self-start" text={`帮我看看这几封没认出来的求职邮件：${subjects.join('；')}`} context={{ surface: 'inbox', note: '接管简报里没认出的历史邮件' }}>交给助理看看</ChatActionButton>
    </section>
  );
}
