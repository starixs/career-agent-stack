/**
 * 邮件投递工作台（功能市场 › 工作台，2026-11-06 用户：「这应该是一级功能」）。
 * 不另做新的 UX：把已经确认过的几样原样搬到自己的一页（用户：「之前已经出过预览，各个 UX 已经确定好了」）——
 *  - 顶上一条开始条：选几家可以投的、写这 N 封；旁边一格把库里没有的岗位贴进来；
 *  - 有几封在等他：主区顶上是和卡组里同一张「N 封邮件写好了」（MailAskCard）；
 *  - 主区：选中那份申请的四步路 + 整封邮件（当场改、当场发）或邮件往来；右边一列是邮件申请，等他过目的钢笔蓝、排最前。
 * 还没有自己的邮件申请时，主区只摆一张预设的「邮件写好了」（MailPresetCard，和卡组单封同一个版式、按钮不可点），
 * 不给一页空白，也不把各个阶段都摆出来；有了第一份真的，整块消失。
 * 挂在投递记录（career-dossier）的 mail-apply 子视图下，标题由那一页给。
 */
import { useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { ErrorRow, LoadingRow } from '@/components/career/CareerPrimitives';
import { deliveryApi, localMidnightIso, type AskView } from '@/components/career/delivery/deliveryApi';
import { useAskActions } from '@/components/career/delivery/useAskActions';
import { ConnectMailbox } from '@/components/career/mail-apply/ConnectMailbox';
import { MailAskCard } from '@/components/career/mail-apply/MailAskCard';
import { mailApplyApi } from '@/components/career/mail-apply/mailApplyApi';
import { applicationRows } from '@/components/career/mail-apply/mailBoard';
import { MailPane } from '@/components/career/mail-apply/MailPane';
import { MailRowList } from '@/components/career/mail-apply/MailRowList';
import { MailPresetCard } from '@/components/career/mail-apply/MailPresetCard';
import { MailStartBar } from '@/components/career/mail-apply/MailStartBar';
import { useCareerQuery } from '@/components/career/useCareerData';
import type { MailBoardRow } from '../../shared/careerMailApply';

import '@/components/career/delivery/delivery.css';
import '@/components/career/mail-apply/mail-apply.css';

/** 这些表变了就重取一次工作台（办完一封、写好一封、来了回信、连了邮箱）。 */
const BOARD_TABLES = ['application', 'action_queue', 'job', 'mail_message', 'mail_account'] as const;

/** 等你条上「N 封邮件写好了」那几件（投递邮件；回信、再争取、退信在右列里一封一封看）。 */
const isApplyGroup = (ask: AskView): boolean => ask.mail?.purpose === 'apply' && !ask.mail.bounced;

function ReadyCards({ asks }: { asks: AskView[] }) {
  const actions = useAskActions();
  return (
    <>
      {asks.map(ask => ask.mail && (
        <div key={ask.id} className="cm-wb-card">
          <MailAskCard ask={ask} mail={ask.mail} busy={actions.busy} error={actions.error}
            onAct={fn => actions.act(fn).then(o => { if (o) emitEvent('career:data-changed', { tables: ['action_queue', 'application'] }); return o; })} />
        </div>
      ))}
    </>
  );
}

function Workspace({ rows, cards, onConnect }: { rows: MailBoardRow[]; cards: AskView[]; onConnect: () => void }) {
  const [current, setCurrent] = useState<string | null>(null);
  const inCards = new Set(cards.flatMap(a => a.mail?.action_ids ?? []));
  // 默认看的那份：表里没有的第一份（表里的已经在顶上摊开了）
  const shown = rows.find(r => r.key === current) ?? rows.find(r => !r.action_id || !inCards.has(r.action_id)) ?? null;
  return (
    <div className="cm-wb-grid">
      <div className="cm-wb-main">
        <ReadyCards asks={cards} />
        {shown && <MailPane key={shown.key} row={shown} onConnect={onConnect} />}
      </div>
      <aside className="cm-wb-side">
        <MailRowList rows={rows} label="邮件申请" current={shown?.key ?? null} onShow={setCurrent} />
      </aside>
    </div>
  );
}

export default function CareerMailApply() {
  const board = useCareerQuery(mailApplyApi.board, BOARD_TABLES);
  const asks = useCareerQuery(() => deliveryApi.asks(localMidnightIso()).then(r => r.asks));
  const [connecting, setConnecting] = useState(false);
  if (board.error && !board.data) return <div className="px-6 py-5"><ErrorRow message={board.error} onRetry={board.reload} /></div>;
  if (!board.data) return <div className="px-6 py-5"><LoadingRow /></div>;
  const live = applicationRows(board.data.rows);
  const ready = board.data.rows.filter(r => r.station === 'ready');
  return (
    <div className="cm-wb cd-root" data-testid="mail-workbench">
      <MailStartBar rows={ready} hasResume={board.data.setup.has_resume !== false}
        onWritten={board.reload} onChanged={board.reload} />
      {live.length === 0
        ? <div className="cm-wb-main cm-wb-first"><MailPresetCard /></div>
        : <Workspace rows={live} cards={(asks.data ?? []).filter(isApplyGroup)} onConnect={() => setConnecting(true)} />}
      {connecting && <ConnectMailbox onClose={() => setConnecting(false)} onConnected={() => { setConnecting(false); board.reload(); }} />}
    </div>
  );
}
