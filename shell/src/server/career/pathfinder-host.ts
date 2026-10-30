/**
 * 把自主找路（pathfinder.ts）接到真实托管浏览器的一份网申上：目标从岗位库 + 求职条件来，
 * 感知 / 操作走 browse.ts（同一套观察编号和提交闸），走通了把做法记成站点做法（site-sop.ts）。
 * 填表引擎内置找路走不通时调用（@career/apply DriveOptions.pathfinder）。
 */
import type { LLM, LlmRequest, LlmResponse } from '@career/core';
import type { BrowserContext, Page } from 'playwright';

import { siteOf } from './app-pages';
import { act, observe, type ActRequest, type BrowseDeps } from './browse';
import { getRepos } from './db';
import { getJobPrefs } from './job-board';
import { findApplicationPage, type PathfinderGoal } from './pathfinder';
import { readSiteSop, rememberSiteSop, sopText } from './site-sop';

export interface PathfinderHostInput {
  context: BrowserContext;
  page: Page;
  applicationId: string;
  llm: { complete(request: unknown): Promise<unknown> };
  /** 填表引擎的提交词判断（apply.isSubmitText）和入口词判断（apply.isEntryText，带该站适配器）。 */
  isSubmitText(text: string): boolean;
  isEntryText(text: string, url: string): boolean;
  resolveVault?(text: string): string;
  focusPage?(page: Page): void;
  log?(msg: string): void;
}

function hasText(v: unknown): v is { text: string } {
  return typeof v === 'object' && v !== null && 'text' in v && typeof v.text === 'string';
}

/** 宿主给的模型接口返回 unknown：在边界上确认有 text 再交给循环。 */
function asLlm(llm: PathfinderHostInput['llm']): LLM {
  return {
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      const res = await llm.complete(req);
      if (!hasText(res)) throw new Error('模型没有返回文字');
      return { text: res.text, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}

async function goalFor(applicationId: string, url: string): Promise<{ goal: PathfinderGoal; site: string | null } | null> {
  const repos = await getRepos();
  const app = repos.getApplication(applicationId);
  const job = app ? repos.getJob(app.job_id) : undefined;
  if (!job) return null;
  const prefs = getJobPrefs(repos);
  const site = siteOf(url);
  return {
    site,
    goal: { company: job.company_name ?? '', jobTitle: job.title, direction: prefs.keywords ?? [], cities: prefs.cities ?? [], degree: prefs.degree ?? null, sop: sopText(readSiteSop(repos, site)) },
  };
}

/** 生成给填表引擎的 pathfinder 回调。 */
export function pathfinderFor(input: PathfinderHostInput): (why: string) => Promise<{ moved: boolean; note?: string }> {
  return async why => {
    const page = input.page;
    const found = await goalFor(input.applicationId, page.url());
    if (!found) return { moved: false };
    const browseDeps: BrowseDeps = {
      // 入口词（该站适配器认可的「投递」、通用的「申请职位」）放行，其余提交类一律不点
      isSubmitText: t => input.isSubmitText(t) && !input.isEntryText(t, page.url()),
      hasPlaceholder: t => /\{\{\s*vault:[^}]+\}\}/.test(t),
      resolveVault: input.resolveVault,
    };
    const doAct = async (req: ActRequest) => {
      const receipt = await act(input.context, page, req, browseDeps);
      // 点开了新标签：把网址收回到引擎手里的这一页，新标签关掉（引擎只认这一页）
      if (receipt.page !== page) {
        const url = receipt.page.url();
        await receipt.page.close().catch(e => input.log?.(`找路：关新标签失败 ${e instanceof Error ? e.message : String(e)}`));
        if (/^https?:/i.test(url)) await page.goto(url, { waitUntil: 'domcontentloaded' });
      }
      input.focusPage?.(page);
      return { ...receipt, page };
    };
    input.log?.(`自主找路开始（${why}）：${found.goal.company} · ${found.goal.jobTitle}${found.goal.sop ? '，带着这个站上次的做法' : ''}`);
    const result = await findApplicationPage({ llm: asLlm(input.llm), observe: () => observe(input.context, page, browseDeps, { textMax: 1500 }), act: doAct, log: input.log }, found.goal);
    console.log(`[career] pathfinder application=${input.applicationId} site=${found.site ?? '?'} state=${result.state} turns=${result.turns}`);
    if (result.state === 'form' || result.state === 'login') {
      rememberSiteSop(await getRepos(), siteOf(page.url()) ?? found.site, result.steps, result.state);
      return { moved: true };
    }
    return { moved: false, note: result.note };
  };
}
