/**
 * 冷启动在对话里的两张卡（Intelligent UI 规范 5.11）：
 *  - 起步卡：还没连邮箱、也没有任何申请时，请用户把手里有的给我。和招聘概览上的起步块读同一份数据，是同一个对象。
 *  - 接管卡：历史邮件收完后，Global 后台推来的一次性简报（kind=takeover）。内容按 account_id 实时读接管简报，
 *    和简报页是同一个对象；结构照回来卡：最急的一件放最大，下面几行事实，已结束只写数字。
 * 规范 6.1：对话里的卡片没有底色、描边、投影的外壳，靠标题和留白组织。
 */
import { emitEvent } from '@/api/eventBus';

import { careerApi } from './careerApi';
import { Button, ErrorRow, LoadingRow } from './CareerPrimitives';
import { CompanyPoster, CompanyTag, CountTag, dueWords } from './CompanyMark';
import { MailConnectCenter } from './mail-connect/MailConnectCenter';
import type { CareerCard, CareerFocusEvent, TakeoverBriefing } from './types';
import { useCareerQuery } from './useCareerData';

const TABLES = ['mail_account', 'mail_message', 'application', 'deadline'] as const;
const ONBOARDING_TABLES = ['mail_account', 'application'] as const;
/** 事实行里每行最多几个小签，其余折成「+N」。 */
const FACT_TAGS = 3;
const TEST_KINDS: ReadonlySet<string> = new Set(['written_test', 'assessment']);

function focus(event: CareerFocusEvent) { emitEvent('career:focus', event); }
export const openApplication = (applicationId: string | null) => { if (applicationId) focus({ surface: 'dossier', application_id: applicationId }); };

/** 一份申请在简报里的公司与岗位（要你的事只带 application_id）。 */
export function appOf(b: TakeoverBriefing, applicationId: string | null): { company: string; title: string } | null {
  if (!applicationId) return null;
  for (const bk of b.buckets) {
    const hit = bk.items.find(i => i.application_id === applicationId);
    if (hit) return { company: hit.company ?? hit.title, title: hit.title };
  }
  return null;
}
export const companyOf = (b: TakeoverBriefing, applicationId: string | null): string | null => appOf(b, applicationId)?.company ?? null;

/** 最急的一件：lg 海报 + 事由 + 期限大字（钢笔蓝只在这里，这是要你动手的事）。 */
export function UrgentNeed({ b, action }: { b: TakeoverBriefing; action?: React.ReactNode }) {
  const need = b.needs[0];
  if (!need) return null;
  const app = appOf(b, need.application_id);
  return (
    <div className="flex flex-wrap items-start gap-4">
      <CompanyPoster company={app?.company ?? need.title} title={app?.title ?? ''} status="waiting" statusText="等你" />
      <div className="grid min-w-0 gap-1">
        <span className="font-human text-lg font-semibold text-[var(--ink)]">{need.title}</span>
        <span className="font-human text-3xl font-semibold text-[var(--primary)]">{dueWords(need.due_at)}</span>
        {action}
      </div>
    </div>
  );
}

function FactRow({ n, label, tags, muted = false }: { n: number; label: string; tags?: string[]; muted?: boolean }) {
  if (!n) return null;
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-sm">
      <span className={`min-w-[92px] tabular-nums ${muted ? 'text-[var(--muted)]' : 'text-[var(--ink)]'}`}><b className="text-lg">{n}</b> {label}</span>
      {tags && (
        <span className="flex flex-wrap gap-1">
          {tags.slice(0, FACT_TAGS).map(t => <CompanyTag key={t} name={t} />)}
          {tags.length > FACT_TAGS && <CountTag n={tags.length - FACT_TAGS} />}
        </span>
      )}
    </div>
  );
}

function names(items: TakeoverBriefing['buckets'][number]['items']): string[] { return items.map(i => i.company ?? i.title); }

export function TakeoverCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const accountId = typeof card.data.account_id === 'string' ? card.data.account_id : null;
  const q = useCareerQuery(() => careerApi.takeover(accountId), TABLES);
  const b = q.data;
  const openBriefing = () => { focus({ surface: 'takeover', id: accountId }); onDone(); };
  if (q.loading && !b) return <LoadingRow />;
  if (q.error) return <ErrorRow message={q.error} onRetry={q.reload} />;
  if (!b) return null;
  const bucket = (id: string) => b.buckets.find(x => x.id === id)?.items ?? [];
  const tests = [...new Set(b.needs.filter(n => TEST_KINDS.has(n.kind)).map(n => companyOf(b, n.application_id) ?? n.title))];
  return (
    <section data-testid="career-card-takeover" aria-label="接管卡" className="grid gap-3 py-1">
      <h4 className="font-human text-lg font-semibold text-[var(--ink)]">
        {b.applications ? `替你接管了 ${b.applications} 家公司的申请` : '邮箱连好了，还没有求职邮件'}
      </h4>
      {b.applications === 0 && <p className="text-sm text-[var(--ink-2)]">你现在大概在{b.season.label}。以后一有网申、笔试、面试邮件就会自动收进来。</p>}
      <UrgentNeed b={b} action={<Button variant="primary" className="mt-1.5 justify-self-start" onClick={() => openApplication(b.needs[0]?.application_id ?? null)}>从最急的开始</Button>} />
      <div className="grid gap-2">
        <FactRow n={bucket('interview').length} label="场面试" tags={names(bucket('interview'))} />
        <FactRow n={tests.length} label="个笔试" tags={tests} />
        <FactRow n={bucket('applied').length} label="已投递" tags={names(bucket('applied'))} />
        <FactRow n={bucket('offer').length} label="个 Offer" tags={names(bucket('offer'))} />
        <FactRow n={bucket('closed').length} label="已结束" muted />
      </div>
      <p className="text-sm text-[var(--subtle)]">
        {b.applications ? '其余没回音的会一直盯着，来信了自动更新。' : ''}
        <button type="button" onClick={openBriefing} className="ml-1 text-[var(--primary)] underline underline-offset-2">看完整简报</button>
      </p>
    </section>
  );
}

/** 起步卡：没连邮箱、也没有任何申请时出现在对话底部；连好任一处，两处（这里和招聘概览）一起消失。 */
export function StarterCard() {
  const q = useCareerQuery(careerApi.onboarding, ONBOARDING_TABLES);
  const d = q.data;
  // 只在明确知道「没有邮箱、也没有申请」时出现；数据不全时不出
  if (!d || d.has_mail_account !== false || d.has_application !== false) return null;
  return (
    <section data-testid="career-starter-card" aria-label="起步卡" className="grid gap-3 py-1">
      <h4 className="font-human text-lg font-semibold text-[var(--ink)]">从你手里有的开始</h4>
      <MailConnectCenter from="chat" />
      <div className="rounded-[10px] border-[1.5px] border-dashed border-[var(--line-2)] px-3.5 py-3 text-sm text-[var(--muted)]">有简历？直接把 PDF 拖到下面的输入框里</div>
      <p className="text-sm text-[var(--subtle)]">什么都还没有也没关系，跟我说说你做过的一件事就行。</p>
    </section>
  );
}
