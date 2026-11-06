/**
 * 示例那一份的主区（sampleBoard.ts）：和真的同一个版式——四步路 + 整封邮件或往来，但整块不可操作（fieldset disabled），
 * 也没有发出 / 不投这两个按钮，免得他以为真发了。
 */
import type { MailBoardRow } from '../../../../shared/careerMailApply';
import { MailSteps } from './MailPane';
import { MailSheet } from './MailSheet';
import { MailThread } from './MailThread';
import { SAMPLE_DRAFT, SAMPLE_THREADS } from './sampleBoard';

const noop = async () => {};

export function MailSamplePane({ row }: { row: MailBoardRow }) {
  const thread = row.application_id ? SAMPLE_THREADS[row.application_id] : undefined;
  return (
    <section className="cm-pane" aria-label={`${row.company.name} ${row.role}`} data-testid="mail-pane">
      <header className="cm-pane-head">
        <h3 className="font-human">{row.company.name}</h3>
        <span>{row.role}</span>
      </header>
      <MailSteps row={row} />
      <fieldset disabled className="cm-sample-body">
        {row.action_id === SAMPLE_DRAFT.action_id && <MailSheet draft={SAMPLE_DRAFT} onPatch={noop} onAvailability={noop} onUpload={noop} />}
        {thread && <MailThread thread={thread} />}
      </fieldset>
    </section>
  );
}
