/**
 * 更正卡（规范 §5.7）：改了被一批申请共用的东西以后，两堆——换成新版的、已投出改不了的（整体变淡）。
 * 不做撤回，不写改了什么；悬停小签看那家是哪家。
 *
 * 只按服务端给的两组渲染。现在还没有接到对话里：没投的申请冻结的是旧版材料包，改主简历后并不会自动换成新版，
 * 「换成新版」那一堆还不是真的（见 .hoshin/face-delivery.md 等你定）。
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
        <p className="cd-fix-n"><b>{sent.length}</b> 家已投出，改不了</p>
        <div className="cd-fix-row">{sent.map(c => <CompanyPoster key={c.name} company={c} size="xs" />)}</div>
      </div>
    </article>
  );
}
