import type { CSSProperties } from "react";
import { currentSupportedLocale } from "@/i18n/format";
import { isClosedIssue } from "./spaceHelpers";

export const PAPER_GRID_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(var(--line) 1px, var(--bg-a0) 1px), linear-gradient(90deg, var(--line) 1px, var(--bg-a0) 1px)",
  backgroundSize: "24px 24px, 24px 24px",
  maskImage:
    "linear-gradient(to bottom, rgb(0 0 0 / 0) 0, 120px, calc(100% - 120px), rgb(0 0 0 / 0) 100%)",
};

export const SPACE_BACKGROUND_STYLE: CSSProperties = {
  background:
    "linear-gradient(180deg, var(--paper), var(--bg) 48%, color-mix(in srgb, var(--bg) 86%, var(--inset)) 100%), var(--bg)",
};

export const SPACE_LIST_FRAME_CLASS = "mx-auto max-w-4xl";
export const SPACE_COLLECTION_FRAME_CLASS = "mx-auto max-w-6xl";
export const SPACE_NARRATIVE_INSET_CLASS = "px-3 max-sm:px-2";
export const SPACE_TWO_COLUMN_GRID_CLASS =
  "grid grid-cols-2 gap-3 max-lg:grid-cols-1";
export const SPACE_PRIMARY_TOOL_BUTTON_CLASS =
  "flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--on-primary)] shadow-sm transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-wait disabled:opacity-70";
export const SPACE_REFRESH_TOOL_BUTTON_CLASS =
  "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--muted)] transition-colors hover:bg-[var(--inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70";

export function formatTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(currentSupportedLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFullTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(currentSupportedLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(currentSupportedLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return "0 KB";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function statusPillClass(status: string): string {
  if (status === "todo") return "bg-[var(--warning-bg)] text-[var(--warning)]";
  if (status === "doing") return "bg-[var(--danger-bg)] text-[var(--danger)]";
  if (status === "done") return "bg-[var(--success-bg)] text-[var(--success)]";
  if (isClosedIssue(status))
    return "bg-[var(--inset)] text-[var(--muted)]";
  return "bg-[var(--inset)] text-[var(--ink)]";
}

export function statusTextClass(status: string): string {
  if (status === "todo") return "text-[var(--warning)]";
  if (status === "doing") return "text-[var(--danger)]";
  if (status === "done") return "text-[var(--success)]";
  if (isClosedIssue(status)) return "text-[var(--muted)]";
  return "text-[var(--ink)]";
}
