import { describe, expect, it } from 'vitest';

import { MORE_ACTIONS_TOOL, routeCareerTools } from './career-tool-router';

const { z } = await import('zod/v4');

type Handler = (args: never, extra: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
const def = (name: string, description: string, inputSchema: Record<string, unknown>, handler: Handler) => ({ name, description, inputSchema, handler });
const echo = (name: string): Handler => async (args) => ({ content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] });

describe('小芽只背主线工具', () => {
  const all = [
    def('jobs_apply', '框选一批开始投。', { job_ids: z.array(z.string()) }, echo('jobs_apply')),
    def('offer_compare', '对比几个 Offer。后面的细节', { offer_ids: z.array(z.string()) }, echo('offer_compare')),
    def('interview_book', '记一场面试。', { company: z.string() }, echo('interview_book')),
  ];
  const routed = routeCareerTools(all, def as never, z);

  it('主线工具直接挂着，其余收进一个入口，入口说明里列出名字和第一句话', () => {
    expect(routed.map(t => t.name)).toEqual(['jobs_apply', MORE_ACTIONS_TOOL]);
    const more = routed[1];
    expect(more.description).toContain('- offer_compare：对比几个 Offer');
    expect(more.description).not.toContain('后面的细节');
  });

  it('入口按原工具的参数校验后转给原工具；参数不对就把要的字段说回去', async () => {
    const more = routed[1];
    const ok = await more.handler({ name: 'interview_book', args: { company: '百度' } } as never, {});
    expect(ok.content[0].text).toBe('interview_book:{"company":"百度"}');
    const bad = await more.handler({ name: 'interview_book', args: {} } as never, {});
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('记一场面试');
  });

  it('在对话里直接填表的老入口不给小芽：投递一律交后台', () => {
    const withLegacy = routeCareerTools([...all, def('apply_prepare', '在这一轮里开浏览器填表。', {}, echo('apply_prepare'))], def as never, z);
    expect(withLegacy.map(t => t.name)).toEqual(['jobs_apply', MORE_ACTIONS_TOOL]);
    expect(withLegacy[1].description).not.toContain('apply_prepare');
  });
});
