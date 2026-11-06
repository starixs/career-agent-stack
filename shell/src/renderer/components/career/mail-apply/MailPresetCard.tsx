/**
 * 邮件投递工作台第一次打开（还没有任何邮件申请）时主区那一张：就是卡组里单封「邮件写好了」的样子，
 * 和 MailAskCard 同一个版式壳（MailCardShell），只是数据用预设的一封（sampleBoard.ts，不请求接口），
 * 邮件不能改（fieldset disabled），「发出」「不投这家」不可点（sampleMode）。
 */
import { mailLabels } from '../delivery/askText';
import { SampleFrame } from '../skills/samples/SampleFrame';
import { MailCardShell, MailPoster } from './MailAskCard';
import { MailSheet } from './MailSheet';
import { PRESET_COMPANY, PRESET_DRAFT } from './sampleBoard';

const noop = async () => {};

export function MailPresetCard() {
  const labels = mailLabels(PRESET_DRAFT.purpose, 1, 1);
  return (
    <SampleFrame>
      <MailCardShell multi={false} testId="mail-preset" title={`${PRESET_COMPANY.name} · 邮件写好了`}
        side={<MailPoster company={PRESET_COMPANY} role={PRESET_DRAFT.role} star={PRESET_DRAFT.target} />}>
        <fieldset disabled className="cm-preset-body">
          <MailSheet draft={PRESET_DRAFT} onPatch={noop} onAvailability={noop} onUpload={noop} />
          <div className="cd-acts">
            <button type="button" className="cd-go">{labels.go}</button>
            <button type="button" className="cd-later">{labels.later}</button>
          </div>
        </fieldset>
      </MailCardShell>
    </SampleFrame>
  );
}
