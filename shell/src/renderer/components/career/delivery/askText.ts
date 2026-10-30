/**
 * 要你的事上的字：期限大字、来源一行、按钮。只管措辞，不做取舍（取舍在服务端 buildAsks）。
 */
import type { AskView } from './deliveryApi';

/** 晚上几点以后说「今晚」而不是「今天」。 */
const EVENING_HOUR = 18;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayDiff = (a: Date, b: Date) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000);

/** 「今晚 23:59」「明天 18:00」「周五 14:00」「11月3日 10:00」。 */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = dayDiff(now, d);
  if (diff === 0) return `${d.getHours() >= EVENING_HOUR ? '今晚' : '今天'} ${hm(d)}`;
  if (diff === 1) return `明天 ${hm(d)}`;
  if (diff === -1) return `昨天 ${hm(d)}`;
  if (diff > 1 && diff < 7) return `周${WEEKDAYS[d.getDay()]} ${hm(d)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}`;
}

/** 期限大字：面试是要去的时间，不是截止；没有自己期限的事用网申截止。 */
export function dueText(ask: AskView, now = new Date()): string | null {
  if (!ask.due_at) return null;
  const when = whenText(ask.due_at, now);
  if (ask.kind === 'attendance' || ask.kind === 'retro') return when;
  if (ask.deadline_kind === 'interview') return when;
  if (ask.kind === 'deadline') return `${when} 截止`;
  return `网申 ${when} 截止`;
}

export function sourceText(ask: AskView, now = new Date()): string | null {
  return ask.source ? `来自邮件 · ${whenText(ask.source.received_at, now)}` : null;
}

/** 卡上一行原因（期限大字之外）。 */
export function subText(ask: AskView): string | null {
  const n = ask.application_ids.length;
  switch (ask.kind) {
    case 'info': return `用于这批 ${n} 家，只存在本机`;
    case 'login': return n > 1 ? `一家一家带你过，登上了自动切下一家` : (ask.detail ?? null);
    case 'start': return `开始后填到提交前停下${n > 1 ? `，${n} 家一起` : ''}`;
    case 'review': {
      const r = ask.review;
      if (n > 1) return ask.detail ?? null; // 一键投出：好几家合成一件
      if (!r || r.required_total === null) return ask.detail ?? null;
      return `必填 ${r.required_filled ?? 0} / ${r.required_total}${r.gaps ? ` · ${r.gaps} 处要看` : ' · 都核对过'}`;
    }
    // 期限类的 detail 是「明天截止」这种，和期限大字重复，不再写
    case 'deadline': return ask.due_at ? null : ask.detail ?? null;
    default: return ask.detail ?? null;
  }
}

const GO: Partial<Record<string, string>> = { assessment: '去做测评', written_test: '去笔试', interview: '准备一下' };

/** 主按钮 / 次按钮的字（≤ 2 个动作，规范 §5.3）。 */
export function actionLabels(ask: AskView): { go: string; later: string } {
  switch (ask.kind) {
    case 'info': return { go: '填好', later: '这批先跳过' };
    case 'login': return { go: '去登录', later: '晚点' };
    case 'start': return { go: '都开始投', later: '晚点' };
    case 'review': return ask.application_ids.length > 1 ? { go: '一键投出', later: '晚点' } : { go: '就这样投出', later: '我要改' };
    case 'confirm': return { go: '投出了', later: '没投出去' };
    case 'attendance': return ask.deadline_kind === 'assessment' ? { go: '做了', later: '没做' } : { go: '考了', later: '没去' };
    case 'retro': return { go: '说几句复盘', later: '不复盘了' };
    default: return { go: GO[ask.deadline_kind ?? ''] ?? '去处理', later: ask.deadline_kind === 'interview' ? '晚点' : '做完了' };
  }
}
