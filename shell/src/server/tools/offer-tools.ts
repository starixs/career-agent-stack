/**
 * Offer 工具：列出（带处境）、录入或修改、并排比较。
 * 对象只有两三个、每个都重，所以列出和比较都带上「处境」：投递阶段（offer 待答复 / hired 已接受）
 * 和还没关的期限（回复截止、三方签约），而不只是 offer 表里那一个回复日期。
 */
import type { tool as SdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { Deadline, Offer, Repos } from '@career/core';
import type { z as Zod } from 'zod/v4';

import type { CareerStore } from '../career/store';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface OfferToolDeps {
  tool: typeof SdkTool;
  z: typeof Zod;
  repos: () => Repos;
  store: () => CareerStore;
  wrap: (fn: () => Promise<ToolResult> | ToolResult) => () => Promise<ToolResult>;
  text: (data: unknown) => ToolResult;
  err: (message: unknown) => ToolResult;
  changed: (...tables: string[]) => void;
  askSkill: (skill: string, user: string, opts?: { temperature?: number }) => Promise<unknown>;
  /** 用户经历与偏好摘要，比较时对照用。 */
  userContext: () => string;
}

export interface OfferSituation {
  id: string; company_name: string | null; title: string | null; location: string | null;
  comp: Record<string, unknown>; content_match: string | null; risk_notes: string | null;
  /** 投递阶段：offer = 待答复，hired = 已接受；没关联投递时为 null。 */
  stage: string | null;
  deadlines: Array<Pick<Deadline, 'title' | 'kind' | 'due_at' | 'status'>>;
}

function parseComp(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch (error) {
    console.warn('[career] offer comp_json 解析失败，按空处理:', error instanceof Error ? error.message : error);
    return {};
  }
}

export function offerSituations(repos: Repos, offers: Offer[]): OfferSituation[] {
  const open = repos.listDeadlines({ status: 'open_or_missed' });
  return offers.map(o => ({
    id: o.id, company_name: o.company_name, title: o.title, location: o.location,
    comp: parseComp(o.comp_json), content_match: o.content_match, risk_notes: o.risk_notes,
    stage: o.application_id ? repos.getApplication(o.application_id)?.stage ?? null : null,
    deadlines: open.filter(d => d.offer_id === o.id).map(d => ({ title: d.title, kind: d.kind, due_at: d.due_at, status: d.status })),
  }));
}

export function createOfferTools(d: OfferToolDeps) {
  const { tool, z } = d;
  return [
    tool('offer_list', '列出所有 Offer 及各自处境：投递阶段（offer = 待答复，hired = 已接受）、还没关的期限（回复截止、三方签约截止）、已知薪酬。比较或讨论 Offer 前先调它拿 offer_id。', {}, d.wrap(() =>
      d.text({ offers: offerSituations(d.repos(), d.store().listOffers()) }))),

    tool('offer_save', '录入或修改一个 Offer（用户在对话里说的薪酬、地点、答复期限等）。传 offer_id 是修改，不传是新建（需要 company_name）。comp 只写用户说过或 offer 原文里写的数，和已有的合并；没说的不要猜。来信里的薪酬归档时已经记下了，先 offer_list 看，已有的不再问；缺的项在比较里标「未知」，不追着用户补。', {
      offer_id: z.string().optional(), application_id: z.string().optional(),
      company_name: z.string().optional(), title: z.string().optional(), location: z.string().optional(),
      comp: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe('如 {"base":32000,"months":15,"signing":30000,"stock":"4 年归属"}'),
      content_match: z.string().optional(), risk_notes: z.string().optional(),
      deadline: z.string().optional().describe('答复期限，ISO 或日期，如 2026-11-21'),
    }, async (args) => d.wrap(() => {
      const s = d.store();
      const { offer_id, comp, ...fields } = args;
      const current = offer_id ? s.getOffer(offer_id) : undefined;
      if (offer_id && !current) return d.err(`Offer 不存在：${offer_id}`);
      if (!current && !fields.company_name) return d.err('新建 Offer 需要 company_name');
      const comp_json = comp ? JSON.stringify({ ...(current ? parseComp(current.comp_json) : {}), ...comp }) : undefined;
      const offer = current ? s.updateOffer(current.id, { ...fields, comp_json }) : s.createOffer({ ...fields, comp_json });
      d.changed('offer', 'deadline');
      return d.text({ offer });
    })()),

    tool('offer_compare', '多个 Offer 放进同一张表拆解比较，列出事实与差异、期限冲突及需用户自行判断的项；不给排序结论。', {
      offer_ids: z.array(z.string()).min(1),
    }, async (args) => d.wrap(async () => {
      const s = d.store();
      const offers = args.offer_ids.map(id => s.getOffer(id)).filter((o): o is Offer => !!o);
      if (offers.length === 0) return d.err('没有找到任何 Offer');
      const companies = offers.flatMap(o => (o.company_name ? [s.findCompany(o.company_name)] : [])).flatMap(c => (c ? [{ name: c.legal_name, traffic_light: c.traffic_light }] : []));
      const out = await d.askSkill('offer-compare', `Offers（含处境：stage 为 hired 表示已接受；deadlines 是还没关的期限）：\n${JSON.stringify(offerSituations(d.repos(), offers), null, 2)}\n\n公司调研：\n${JSON.stringify(companies)}\n\n${d.userContext()}`, { temperature: 0.2 });
      return d.text(out);
    })()),
  ];
}
