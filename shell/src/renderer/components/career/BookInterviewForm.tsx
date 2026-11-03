/**
 * 「我约了一场面试」：HR 电话 / 短信 / 微信约的面试，邮箱里没有，用户自己记一场。
 * 记下后这份申请推进到面试、日历上有这个时间点；同一场再记一次只改时间。
 */
import { useState } from 'react';

import { careerApi } from './careerApi';
import { Button, Card, Field, Select, TextInput } from './CareerPrimitives';
import { useCareerAction } from './useCareerData';

const ROUNDS = ['一面', '二面', '三面', '终面', 'HR 面', '群面', '其他'].map(r => ({ value: r, label: r }));

export function BookInterviewForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ company_name: '', title: '', round: '一面', when: '', location: '', note: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = () => action.run(async () => {
    if (!form.company_name.trim()) throw new Error('请填写公司');
    if (!form.when) throw new Error('请填写面试时间');
    await careerApi.bookInterview({
      company_name: form.company_name.trim(), title: form.title.trim() || null, round: form.round,
      when: new Date(form.when).toISOString(), location: form.location.trim() || null, note: form.note.trim() || null,
    });
    onDone();
  });
  return (
    <Card title="我约了一场面试">
      <p className="mb-2 text-xs text-[var(--muted)]">电话、短信或微信约的面试邮箱里没有，在这里记一下，日历和今日待办里就有它。</p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="公司"><TextInput value={form.company_name} onChange={set('company_name')} placeholder="如 百度" /></Field>
        <Field label="岗位"><TextInput value={form.title} onChange={set('title')} placeholder="可不填" /></Field>
        <Field label="轮次"><Select value={form.round} onChange={v => setForm(f => ({ ...f, round: v }))} options={ROUNDS} ariaLabel="轮次" /></Field>
        <Field label="时间"><TextInput type="datetime-local" value={form.when} onChange={set('when')} aria-label="面试时间" /></Field>
        <Field label="地点或会议链接"><TextInput value={form.location} onChange={set('location')} placeholder="可不填" /></Field>
        <Field label="备注"><TextInput value={form.note} onChange={set('note')} placeholder="如 联系人、要带的材料" /></Field>
      </div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>记下来</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}
