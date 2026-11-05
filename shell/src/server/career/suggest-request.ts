/**
 * /api/career/suggest 的请求体校验（跨边界：renderer → sidecar）。坏的字段丢掉不报错：建议条是锦上添花，不该因为一个字段挡住整条。
 */
import { z } from 'zod';

import {
  SUGGEST_MAX_TOOLS, SUGGEST_MAX_TURNS, SUGGEST_TURN_CHARS, type SuggestRequest, type SuggestThisTurn, type SuggestTurn,
} from '../../shared/careerSuggest';

/** 工具名只留小写加下划线（前端已去掉 mcp__xx__ 前缀）。 */
const TOOL_NAME = /^[a-z_]+$/;
/** 离开时长上限：一年，再大就是坏数据。 */
const AWAY_HOURS_MAX = 24 * 365;

const Turn = z.object({ role: z.enum(['user', 'assistant']), text: z.string() });

function turnsOf(raw: unknown): SuggestTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: SuggestTurn[] = [];
  for (const item of raw) {
    const t = Turn.safeParse(item);
    if (t.success && t.data.text.trim()) turns.push({ role: t.data.role, text: t.data.text.slice(0, SUGGEST_TURN_CHARS) });
  }
  return turns.slice(-SUGGEST_MAX_TURNS);
}

function toolsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && TOOL_NAME.test(t)).slice(0, SUGGEST_MAX_TOOLS);
}

function awayOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= AWAY_HOURS_MAX ? raw : null;
}

/** 一轮最多放几张卡（种类名）：再多就是坏数据。 */
const MAX_TURN_CARDS = 8;
const CARD_KIND = /^[a-z_]+$/;

/** 这一轮：他说的、小芽说的、工具、卡（plan-r4 §2.3）；不是对象就当没有。 */
function thisTurnOf(raw: unknown): SuggestThisTurn | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = Object.fromEntries(Object.entries(raw));
  const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, SUGGEST_TURN_CHARS) : '');
  const cards = Array.isArray(r.cards) ? r.cards.filter((c): c is string => typeof c === 'string' && CARD_KIND.test(c)).slice(0, MAX_TURN_CARDS) : [];
  return { user: text(r.user), assistant: text(r.assistant), tools: toolsOf(r.tools), cards };
}

const textOrNull = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() ? raw.slice(0, SUGGEST_TURN_CHARS) : null);

export function parseSuggestRequest(body: Record<string, unknown>): SuggestRequest {
  const pending = Array.isArray(body.pending_cards) ? body.pending_cards.filter((x): x is string => typeof x === 'string') : [];
  return {
    last_user: textOrNull(body.last_user),
    last_assistant: textOrNull(body.last_assistant),
    pending_cards: pending,
    turns: turnsOf(body.turns),
    last_tools: toolsOf(body.last_tools),
    away_hours: awayOf(body.away_hours),
    this_turn: thisTurnOf(body.this_turn),
    source: body.source === 'hook' ? 'hook' : 'poll',
  };
}
