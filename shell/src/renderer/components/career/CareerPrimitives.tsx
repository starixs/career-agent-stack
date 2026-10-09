/**
 * 求职面板共用的小组件：页面骨架、「交给助理」按钮、徽标、按钮、表单项、空态、结构化 JSON 展示。
 * 视觉规则见 specs/CAREER_DESIGN.md：按钮 7.1、状态标签 6.0、卡片 2.3、字阶 3.2。
 */
import { AlertCircle, Loader2, MessageSquareText } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

import { emitEvent } from '@/api/eventBus';
import CustomSelect from '@/components/CustomSelect';
import { useToastOptional } from '@/components/Toast';
import { copyPlainText } from '@/utils/clipboard';

// ─── 由对话指挥 ───

export interface ChatContext { surface?: string; refs?: Record<string, string | null | undefined>; note?: string }

/**
 * 面板把一句话真的发进唯一的个人助理对话（Chat 订阅 `career:chat-suggest` 后调用 sendMessage，App 同时把焦点切到对话）。
 * 带上对象 id 作为隐藏上下文，模型无需再问"哪一份"。剪贴板只是兜底：对话尚未就绪时用户仍能粘贴。
 */
export function suggestToChat(text: string, context?: ChatContext, mode: 'send' | 'prefill' = 'send'): void {
  emitEvent('career:chat-suggest', { text, context, mode });
  copyPlainText(text).catch(() => { /* 剪贴板不可用时静默 */ });
}

export function useSuggestToChat(): (text: string, context?: ChatContext) => void {
  const toast = useToastOptional();
  return (text: string, context?: ChatContext) => {
    suggestToChat(text, context);
    toast?.info(`已交给助理：「${text.length > 24 ? `${text.slice(0, 24)}…` : text}」`);
  };
}

/** 面板上的"让助理做"按钮：点一下就把带对象上下文的意图发进对话。 */
export function ChatActionButton({ text, context, children, variant = 'secondary', size, className }: { text: string; context?: ChatContext; children?: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; size?: keyof typeof BUTTON_SIZES; className?: string }) {
  const suggest = useSuggestToChat();
  return (
    <Button variant={variant} size={size} className={className} onClick={() => suggest(text, context)}>
      <MessageSquareText className="h-4 w-4" strokeWidth={1.75} />
      {children ?? text}
    </Button>
  );
}

export function CommandHint({ examples }: { examples: string[] }) {
  const suggest = useSuggestToChat();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-[var(--muted)]">
      <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--primary)]" strokeWidth={1.75} />
      <span>这一页由对话指挥：你可以在对话里直接说</span>
      {examples.map(ex => (
        <button
          key={ex}
          type="button"
          onClick={() => suggest(ex)}
          className="rounded-full border border-[var(--line-2)] px-2.5 py-0.5 text-xs text-[var(--ink-2)] transition-colors hover:border-[var(--primary)] hover:bg-[var(--primary-soft)] hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        >
          「{ex}」
        </button>
      ))}
    </div>
  );
}

// ─── 页面骨架 ───

export function CareerPage({ title, subtitle, examples, actions, children, embedded = false }: {
  title: string; subtitle?: string; examples: string[]; actions?: ReactNode; children: ReactNode;
  /** 作为别的面的一个视图嵌入时不渲染页头与示例话术。 */
  embedded?: boolean;
}) {
  if (embedded) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--ink)]">
        {actions && <div className="flex flex-wrap items-center justify-end gap-2 px-6 pt-3">{actions}</div>}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--ink)]">
      <div className="flex flex-col gap-3 border-b border-[var(--line)] px-6 pb-3 pt-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-human text-lg font-semibold">{title}</h1>
          {subtitle && <span className="text-xs text-[var(--muted)]">{subtitle}</span>}
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
      <span className="text-xs font-medium text-[var(--muted)]">{children}</span>
      {extra}
    </div>
  );
}

/**
 * 区块。默认直接放在纸面上，不画框（2.3「去掉不必要的卡片」）；
 * 只有「待你批准」用 `approval`：纸底、1.5px 墨线描边、3px 硬投影，意思是「这里在等你」。
 */
export function Card({ title, extra, children, className = '', variant = 'plain' }: {
  title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; variant?: 'plain' | 'approval';
}) {
  const surface = variant === 'approval'
    ? 'rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] p-4 shadow-hard-lg'
    : 'py-1';
  return (
    <section className={`${surface} ${className}`}>
      {(title || extra) && (
        <div className="mb-2 flex items-center gap-2">
          {title && <div className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]">{title}</div>}
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
      <div className="text-sm text-[var(--muted)]">{title}</div>
      {hint && <div className="max-w-md text-xs text-[var(--subtle)]">{hint}</div>}
      {example && (
        <Button variant="secondary" onClick={() => suggest(example)}>在对话里说「{example}」</Button>
      )}
    </div>
  );
}

export function LoadingRow({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-[var(--muted)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {text}
    </div>
  );
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">重试</button>}
    </div>
  );
}

// ─── 徽标 / 按钮 ───

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'text-[var(--muted)]',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--danger)]',
  info: 'text-[var(--info)]',
  accent: 'text-[var(--primary)]',
};

/** 状态标签（6.0 方案 C）：3px 状态色竖条 + 状态色文字，不铺底、不加框、不换行。 */
export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-5 items-center gap-2 whitespace-nowrap text-xs font-medium ${BADGE_TONES[tone]}`}>
      <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** 描边按钮（7.1）：Primary / Secondary 带 1.5px 墨线与 2px 硬投影，按下时投影收回；Ghost 与 Danger 不描边。 */
const OUTLINED = 'border-[1.5px] border-[var(--hard)] shadow-hard active:translate-x-px active:translate-y-px active:shadow-none disabled:border-[var(--line-2)] disabled:bg-[var(--inset)] disabled:shadow-none';
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: `${OUTLINED} bg-[var(--primary)] text-[var(--on-primary)] hover:bg-[var(--primary-hover)]`,
  secondary: `${OUTLINED} bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--hover)]`,
  ghost: 'border-[1.5px] border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]',
  danger: 'border-[1.5px] border-transparent bg-transparent text-[var(--danger)] hover:bg-[var(--danger-bg)]',
};

const BUTTON_SIZES = {
  /** 工作台卡片的唯一主动作（7.4）。 */
  lg: 'h-10 px-4',
  md: 'h-8 px-3.5',
  /** 列表行内、工具栏。 */
  sm: 'h-[30px] px-3',
} as const;

export function Button({ variant = 'secondary', size = 'md', busy, className = '', children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: keyof typeof BUTTON_SIZES; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:cursor-not-allowed disabled:text-[var(--subtle)] ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

// ─── 表单 ───

const CONTROL_CLASS = 'w-full rounded-md border border-[var(--line-2)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-muted)]';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--subtle)]">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL_CLASS} h-9 ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL_CLASS} min-h-[72px] py-2 font-[var(--font-sans)] ${props.className ?? ''}`} />;
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
  if (value == null || value === '') return <span className="text-[var(--subtle)]">未知</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--subtle)]">（空）</span>;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, i) => <li key={i}><StructuredJson value={item} depth={depth + 1} /></li>)}
      </ul>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-[var(--subtle)]">（空）</span>;
    return (
      <dl className={`grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-1 ${depth > 0 ? 'mt-1' : ''}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-[var(--muted)]">{k}</dt>
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
