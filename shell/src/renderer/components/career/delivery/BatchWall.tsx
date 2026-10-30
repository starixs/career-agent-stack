/**
 * 批次卡（规范 §5.5）：一句「这些都帮我投」开的那批申请，原地更新。标星的目标岗位中海报在上，其余小海报成格；
 * 只反映状态，不放动作（动作都在等你条）。悬停排队中的一家可以说「这家我要看」（标成目标，投前先给你看）。
 */
import { careerApi } from '../careerApi';
import { useCareerQuery } from '../useCareerData';
import { CompanyPoster } from './CompanyPoster';
import { deliveryApi, type PosterState, type RunView } from './deliveryApi';

const OVER: Record<PosterState, string> = { wait: '排队', run: '定制中', done: '已投出', ask: '等你', failed: '没投成', next: '排队' };

export function BatchWall({ run, compact, onWatch }: { run: RunView; compact?: boolean; onWatch?: (jobId: string) => void }) {
  const targets = run.items.filter(i => i.star);
  const rest = run.items.filter(i => !i.star);
  return (
    <article className={`cd-batch ${compact ? 'is-compact' : ''}`} data-testid="batch-wall">
      <header className="cd-batch-head">
        <h3 className="font-human">投 {run.total} 家</h3>
        <span className="cd-batch-stat">
          <b>{run.done}</b> 已投出
          {run.running > 0 && <> · {run.running} 在投</>}
          {run.asking > 0 && <> · <em>{run.asking} 等你</em></>}
          {run.failed > 0 && <> · {run.failed} 没投成</>}
        </span>
      </header>
      {targets.length > 0 && (
        <div className="cd-batch-targets">{targets.map(i => <CompanyPoster key={i.application_id} company={i.company} role={i.role} size="md" state={i.state} over={OVER[i.state]} star />)}</div>
      )}
      <div className="cd-batch-grid">
        {rest.map(i => (
          <span key={i.application_id} className="cd-batch-cell">
            <CompanyPoster company={i.company} role={i.role} size="sm" state={i.state} />
            {onWatch && i.state === 'wait' && <button type="button" className="cd-watch" onClick={() => onWatch(i.job_id)}>这家我要看</button>}
          </span>
        ))}
      </div>
    </article>
  );
}

/** 对话里的批次卡：按这次开的那几份填表动作取数，数据变了就重取。 */
export function BatchWallCard({ actionIds }: { actionIds: readonly string[] }) {
  const key = actionIds.join(',');
  const { data: run, reload } = useCareerQuery(() => deliveryApi.run(key.split(',')), ['action_queue', 'application', 'handoff', 'kv']);
  if (!run) return null;
  const watch = (jobId: string) => { void careerApi.setJobTarget(jobId, true).then(reload, (e: unknown) => console.error('[career] 标目标 FAILED', jobId, e)); };
  return <div className="cd-root"><BatchWall run={run} onWatch={watch} /></div>;
}
