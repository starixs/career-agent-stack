/**
 * 六个求职页面共用的小组件：页面骨架、「由对话指挥」提示、徽标、按钮、表单项、空态、结构化 JSON 展示。
 * 样式沿用壳的主题 token（--ink / --paper / --line / --accent …），不引入新的视觉语言。
 */
import { AlertCircle, Loader2, MessageSquareText } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

import { emitEvent } from '@/api/eventBus';
import CustomSelect from '@/components/CustomSelect';
import { useToastOptional } from '@/components/Toast';
import { copyPlainText } from '@/utils/clipboard';

// ─── 由对话指挥 ───

/** 页面把一句建议交给对话：广播给 Chat Tab（收敛侧可订阅 `career:chat-suggest` 预填输入框），并复制到剪贴板兜底。 */
export function suggestToChat(text: string): void {
  emitEvent('career:chat-suggest', { text });
  copyPlainText(text).catch(() => { /* 剪贴板不可用时静默，对话侧仍能收到建议 */ });
}

export function useSuggestToChat(): (text: string) => void {
  const toast = useToastOptional();
  return (text: string) => {
    suggestToChat(text);
    toast?.info(`已把「${text}」交给对话（同时复制到剪贴板）`);
  };
}

export function CommandHint({ examples }: { examples: string[] }) {
  const suggest = useSuggestToChat();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-3 py-2 text-xs text-[var(--ink-muted)]">
      <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" strokeWidth={1.75} />
      <span>这一页由对话指挥：你可以在对话里直接说</span>
      {examples.map(ex => (
        <button
          key={ex}
          type="button"
          onClick={() => suggest(ex)}
          className="rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-0.5 text-xs text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          「{ex}」
        </button>
      ))}
    </div>
  );
}

// ─── 页面骨架 ───

export function CareerPage({ title, subtitle, examples, actions, children }: {
  title: string; subtitle?: string; examples: string[]; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--paper)] text-[var(--ink)]">
      <div className="flex flex-col gap-2 border-b border-[var(--line-subtle)] px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <span className="text-xs text-[var(--ink-muted)]">{subtitle}</span>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        <CommandHint examples={examples} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{children}</span>
      <span className="h-px flex-1 bg-[var(--line-subtle)]" aria-hidden />
      {extra}
    </div>
  );
}

export function Card({ title, extra, children, className = '' }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 ${className}`}>
      {(title || extra) && (
        <div className="mb-2 flex items-center gap-2">
          {title && <div className="text-sm font-medium text-[var(--ink)]">{title}</div>}
          {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, hint, example }: { title: string; hint?: string; example?: string }) {
  const suggest = useSuggestToChat();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-sm text-[var(--ink-muted)]">{title}</div>
      {hint && <div className="max-w-md text-xs text-[var(--ink-subtle)]">{hint}</div>}
      {example && (
        <Button variant="secondary" onClick={() => suggest(example)}>在对话里说「{example}」</Button>
      )}
    </div>
  );
}

export function LoadingRow({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {text}
    </div>
  );
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">重试</button>}
    </div>
  );
}

// ─── 徽标 / 按钮 ───

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--paper-inset)] text-[var(--ink-muted)] border-[var(--line-subtle)]',
  success: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/20',
  warning: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/20',
  error: 'bg-[var(--error-bg)] text-[var(--error)] border-[var(--error)]/20',
  info: 'bg-[var(--info-bg)] text-[var(--info)] border-[var(--info)]/20',
  accent: 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] border-transparent',
  secondary: 'bg-[var(--paper)] text-[var(--ink)] border-[var(--line)] hover:bg-[var(--paper-inset)]',
  ghost: 'bg-transparent text-[var(--ink-muted)] border-transparent hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]',
  danger: 'bg-[var(--error-bg)] text-[var(--error)] border-[var(--error)]/30 hover:bg-[var(--error-bg)]',
};

export function Button({ variant = 'secondary', busy, className = '', children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}

// ─── 表单 ───

const CONTROL_CLASS = 'w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--focus-border)] focus:outline-none';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--ink-subtle)]">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL_CLASS} ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL_CLASS} min-h-[72px] font-[var(--font-body)] ${props.className ?? ''}`} />;
}

/** 主题化下拉（壳的 CustomSelect），表单项统一用它；onChange 直接给值。 */
export function Select({ value, options, onChange, ariaLabel, placeholder, disabled }: {
  value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void;
  ariaLabel?: string; placeholder?: string; disabled?: boolean;
}) {
  return <CustomSelect value={value} options={options} onChange={onChange} ariaLabel={ariaLabel} placeholder={placeholder} disabled={disabled} />;
}

// ─── 结构化 JSON 展示 ───

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 把任意 JSON 渲染成可读的键值 / 列表，用于复盘、报告、理由等字段。 */
export function StructuredJson({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null || value === '') return <span className="text-[var(--ink-subtle)]">未知</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--ink-subtle)]">（空）</span>;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, i) => <li key={i}><StructuredJson value={item} depth={depth + 1} /></li>)}
      </ul>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-[var(--ink-subtle)]">（空）</span>;
    return (
      <dl className={`grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1 ${depth > 0 ? 'mt-1' : ''}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-[var(--ink-muted)]">{k}</dt>
            <dd className="min-w-0 text-sm"><StructuredJson value={v} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

// ─── 小工具 ───

export function formatDate(value: string | null | undefined, fallback = '未知'): string {
  if (!value) return fallback;
  return value.length > 10 ? value.slice(0, 10) : value;
}

export function textOrUnknown(value: string | number | null | undefined): string {
  return value == null || value === '' ? '未知' : String(value);
}

export function fileDirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : path;
}
