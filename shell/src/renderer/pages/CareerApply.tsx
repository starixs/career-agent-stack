/**
 * 岗位收藏：页面主体就是岗位多维表格（JobBoard）。
 *
 * 「等你批准」的动作队列在通知中心处理，这里不再重复。留下的只有正确性需要的两样：
 *  - 结果不确定的提交（点了提交没等到成功提示）：有才出现一条提示，必须由用户确认，否则这条投递会一直卡着；
 *  - 浏览器在跑 / 停下等你接管时的状态条：空闲时不占位。
 * auto 模式开关跟「加入待投清单」放在一起（它决定加进去的网申是否检查通过直接提交）。
 */
import { BrowserStatusBar } from '@/components/career/BrowserStatusBar';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { JobBoard } from '@/components/career/JobBoard';
import { Badge, Button, CareerPage, ErrorRow } from '@/components/career/CareerPrimitives';
import { approvalLabel } from '@/components/career/SubmitReviewList';
import type { ActionQueueItem, Application, ApplySettings } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

interface ApplyData { confirming: ActionQueueItem[]; applications: Application[]; settings: ApplySettings }

async function loadAll(): Promise<ApplyData> {
  const [confirming, applications, settings] = await Promise.all([
    careerApi.submitsNeedingUser().catch(() => []), careerApi.applications().catch(() => []),
    careerApi.applySettings().catch((): ApplySettings => ({ auto_mode: false, learn_threshold: 3 })),
  ]);
  return { confirming, applications, settings };
}

export default function CareerApply({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(loadAll, ['application', 'action_queue']);
  const data = query.data;
  const modeAction = useCareerAction();
  const setAuto = (enabled: boolean) => modeAction.run(async () => { await careerApi.setAutoMode(enabled); query.reload(); });
  const labelOf = (action: ActionQueueItem) => {
    const app = action.application_id ? data?.applications.find(a => a.id === action.application_id) : undefined;
    return app?.title ? `${app.company_name ?? '未知公司'} · ${app.title}` : '未关联岗位';
  };

  return (
    <CareerPage embedded={embedded} title="岗位收藏">
      <div className="flex h-full min-h-0 flex-col">
        <BrowserStatusBar hideWhenIdle />
        {data && data.confirming.length > 0 && (
          <div className="px-6 pt-4"><ConfirmSubmits actions={data.confirming} labelOf={labelOf} onChanged={query.reload} /></div>
        )}
        {modeAction.error && <div className="px-6 pt-2"><ErrorRow message={modeAction.error} /></div>}
        <JobBoard
          onChanged={query.reload}
          bulkExtra={data && <AutoModeToggle settings={data.settings} busy={modeAction.busy} onChange={enabled => void setAuto(enabled)} />}
        />
      </div>
    </CareerPage>
  );
}

function AutoModeToggle({ settings, busy, onChange }: { settings: ApplySettings; busy: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <label
      className="flex items-center gap-1.5 text-xs text-[var(--muted)]"
      title={`开启后：填完检查全部通过的网申直接提交，有需要你看的项仍会停下。另外，同一张表你连续 ${settings.learn_threshold} 次没改直接批准、简历和开放题答案没变时，会自动免确认。`}
    >
      <input type="checkbox" aria-label="auto 模式" checked={settings.auto_mode} disabled={busy} onChange={e => onChange(e.target.checked)} />
      auto 模式（检查通过直接提交）
    </label>
  );
}

/** 点了提交但没等到成功提示 / 提交时遇到验证码：等用户到页面上确认结果。 */
function ConfirmSubmits({ actions, labelOf, onChanged }: { actions: ActionQueueItem[]; labelOf: (a: ActionQueueItem) => string; onChanged: () => void }) {
  const act = useCareerAction();
  const confirm = (id: string, submitted: boolean) => act.run(async () => { await careerApi.confirmSubmit(id, submitted); onChanged(); });
  return (
    <div className="space-y-2">
      {actions.map(a => {
        const result = safeJson<Record<string, unknown>>(a.result_json, {});
        return (
          <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-[3px] border-[var(--warning)] py-1 pl-3 text-sm">
            <Badge tone="warning">等你确认</Badge>
            <span className="font-medium text-[var(--ink)]">{labelOf(a)}</span>
            <span className="text-xs text-[var(--muted)]">{typeof result.message === 'string' ? result.message : '提交结果不确定，请到页面上看一下'}</span>
            {approvalLabel(a.approved_by) && <span className="text-[var(--subtle)]">（{approvalLabel(a.approved_by)}）</span>}
            <span className="flex-1" />
            <Button size="sm" variant="primary" busy={act.busy} onClick={() => void confirm(a.id, true)}>已投递成功</Button>
            <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void confirm(a.id, false)}>没投出去，重新审核</Button>
          </div>
        );
      })}
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}
