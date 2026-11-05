/**
 * 邮件预览里的几格：一行字（收件人、标题）、正文、实习到岗点选。
 * 改动失焦时才存；存的时候不换掉他正在看的字（不闪）；存不上在那一格下面说原因，打的字留着。
 */
import { useId, useState } from 'react';

import {
  INTERN_DAYS_OPTIONS, INTERN_MONTHS_OPTIONS, INTERN_START_OPTIONS,
  type InternAvailability,
} from '../../../../shared/careerMailApply';
import { useAutoGrow } from './useAutoGrow';

/** 一格的保存：成功返回 true；失败记下原因（带哪一格），不吞。 */
export function useFieldSave(field: string) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null); setSaving(true);
    try { await fn(); return true; } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[career] mail-apply save FAILED field=${field}`, message);
      setError(message || '没能保存，请重试');
      return false;
    } finally { setSaving(false); }
  };
  return { error, saving, run };
}

/** 本地的字跟着服务端的值走，除非他改了还没存上（失败时留着他打的字）。 */
function useSyncedText(value: string) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [held, setHeld] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (!held) setText(value);
  }
  return { text, setText, hold: setHeld };
}

export function TextField({ label, value, invalid, multiline, onSave }: {
  label: string; value: string; invalid?: boolean; multiline?: boolean; onSave: (v: string) => Promise<unknown>;
}) {
  const { text, setText, hold } = useSyncedText(value);
  const save = useFieldSave(label);
  const errId = useId();
  const growRef = useAutoGrow(text);
  const commit = async () => {
    if (text === value) return;
    const ok = await save.run(() => onSave(text));
    hold(!ok);
  };
  const common = {
    'aria-label': label, 'aria-invalid': invalid || !!save.error, 'aria-describedby': save.error ? errId : undefined,
    value: text, onBlur: () => void commit(), spellCheck: false,
  };
  return (
    <div className={`cm-field${multiline ? ' cm-field-body' : ''}${invalid ? ' cm-bad' : ''}`}>
      {multiline
        ? <textarea ref={growRef} className="cm-body" {...common} onChange={e => setText(e.target.value)} />
        : <input className="cm-line" type="text" autoComplete="off" {...common} onChange={e => setText(e.target.value)} />}
      {save.error && <p id={errId} role="alert" className="cd-err">{save.error}</p>}
    </div>
  );
}

const AVAIL_GROUPS: ReadonlyArray<{ key: keyof InternAvailability; label: string; options: readonly string[]; unit: string }> = [
  { key: 'days_per_week', label: '每周', options: INTERN_DAYS_OPTIONS, unit: ' 天' },
  { key: 'months', label: '实习', options: INTERN_MONTHS_OPTIONS, unit: ' 个月' },
  { key: 'start', label: '到岗', options: INTERN_START_OPTIONS, unit: '' },
];

export const availabilityComplete = (a: InternAvailability | null): a is InternAvailability =>
  !!a && !!a.days_per_week && !!a.months && !!a.start;

/** 到岗信息三组点选：选满即存。已齐的不出现（调用方判断）。 */
export function AvailabilityRow({ value, onSave }: { value: InternAvailability; onSave: (v: InternAvailability) => Promise<unknown> }) {
  const [picked, setPicked] = useState<InternAvailability>(value);
  const save = useFieldSave('availability');
  const choose = (key: keyof InternAvailability, option: string) => {
    const next = { ...picked, [key]: option };
    setPicked(next);
    if (availabilityComplete(next)) void save.run(() => onSave(next));
  };
  return (
    <div className="cm-avail" data-testid="mail-availability">
      {AVAIL_GROUPS.map(g => (
        <div key={g.key} className="cm-avail-group">
          <span className="cm-label">{g.label}</span>
          <div className="cd-choices" role="radiogroup" aria-label={g.label}>
            {g.options.map(o => (
              <button key={o} type="button" role="radio" aria-checked={picked[g.key] === o} disabled={save.saving}
                className={`cd-choice${picked[g.key] === o ? ' cd-choice-on' : ''}`} onClick={() => choose(g.key, o)}>{o}{g.unit}</button>
            ))}
          </div>
        </div>
      ))}
      {save.error && <p role="alert" className="cd-err">{save.error}</p>}
    </div>
  );
}
