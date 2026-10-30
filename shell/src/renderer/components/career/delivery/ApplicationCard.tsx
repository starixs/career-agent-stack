/**
 * 申请对象卡（规范 §5.8）：问「京东那份怎样了」时出现。左边公司大海报，右边一条从投出到下一步的路；
 * 动作悬停才出现（等你的那一节打开卡组，另一个看卷宗）。数据来自卷宗和同一份要你的事。
 */
import { emitEvent } from '@/api/eventBus';

import { careerApi } from '../careerApi';
import type { CareerFocusEvent } from '../types';
import { useCareerQuery } from '../useCareerData';
import { applicationTrack } from './applicationTrack';
import { CompanyPoster } from './CompanyPoster';
import { deliveryApi, localMidnightIso, type CompanyMark } from './deliveryApi';
import { OPEN_DECK_EVENT } from './ReturnCard';

import './delivery.css';

/** company 由服务端随卡片给（CompanyMark）；缺省只写名字。 */
export function ApplicationCard({ applicationId, company: mark }: { applicationId: string; company?: CompanyMark | null }) {
  const dossier = useCareerQuery(() => careerApi.dossier(applicationId), ['application', 'application_history', 'deadline', 'interview']);
  const asks = useCareerQuery(() => deliveryApi.asks(localMidnightIso()).then(r => r.asks));
  const d = dossier.data;
  if (!d?.application || !d.job) return null;
  const mine = (asks.data ?? []).filter(a => a.application_ids.includes(applicationId));
  const track = applicationTrack(d, mine);
  const company: CompanyMark = mark ?? { company_id: d.job.company_id, name: d.job.company_name ?? '未知公司' };
  const waiting = track.find(n => n.ask);
  const waitingAsk = waiting ? mine.find(a => a.sources.some(src => src.id === waiting.key)) : undefined;
  return (
    <article className="cd-app cd-root" data-testid="application-card">
      <CompanyPoster company={company} size="lg" role={d.job.title} state={waiting ? 'ask' : 'done'} />
      <div className="cd-app-text">
        <h3 className="font-human">{d.job.company_name}<span>{d.job.title}</span></h3>
        <ol className="cd-track">
          {track.map(n => (
            <li key={n.key} className={`${n.on ? 'on' : ''} ${n.ask ? 'ask' : ''}`}>
              <i />
              <span>{n.label}</span>
              {n.date && <small>{n.date}</small>}
            </li>
          ))}
        </ol>
        <div className="cd-acts cd-acts-hover">
          {waiting && waitingAsk && <button type="button" className="cd-go-text" onClick={() => emitEvent(OPEN_DECK_EVENT, { id: waitingAsk.id })}>{waiting.label} →</button>}
          <button type="button" className="cd-later" onClick={() => emitEvent('career:focus', { surface: 'dossier', application_id: applicationId, origin: 'user' } satisfies CareerFocusEvent)}>看卷宗</button>
        </div>
      </div>
    </article>
  );
}
