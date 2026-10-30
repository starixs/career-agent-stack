/**
 * 更正卡（规范 §5.7）：改了被一批申请共用的东西以后，两堆——换成新版的、已投出改不了的（整体变淡）。
 * 不做撤回，不写改了什么；悬停小签看那家是哪家。
 *
 * 两组由服务端给（career/correction.ts）：排着队还没开始填的已换成新版；在填、待提交、已投出的改不了
 * （2026-10-30 你定）。所以第二堆不只是「已投出」，字上照实写。
 */
import { CompanyPoster } from './CompanyPoster';
import type { CompanyMark } from './deliveryApi';

import './delivery.css';

export function FixCard({ swapped, sent }: { swapped: CompanyMark[]; sent: CompanyMark[] }) {
  return (
    <article className="cd-fix cd-root" data-testid="fix-card">
      <div className="cd-fix-col">
        <p className="cd-fix-n"><b>{swapped.length}</b> 家换成新版</p>
        <div className="cd-fix-row">{swapped.map(c => <CompanyPoster key={c.name} company={c} size="xs" state="next" />)}</div>
      </div>
      <div className="cd-fix-col is-locked">
        <p className="cd-fix-n"><b>{sent.length}</b> 家已经在投或投出，改不了</p>
        <div className="cd-fix-row">{sent.map(c => <CompanyPoster key={c.name} company={c} size="xs" />)}</div>
      </div>
    </article>
  );
}
