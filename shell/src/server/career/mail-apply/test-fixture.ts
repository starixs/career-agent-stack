/**
 * 测试辅助（只给 mail-apply 的 *.unit.test.ts 和邮件投递切面测试用）：内存库 + 私密库 + 假导出 + 假定制 + 假模型。
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { FakeLLM, StaticKeyProvider, Vault, type Repos } from '@career/core';

import { loadCore } from '../core-module';
import { backgroundAskSkill } from '../skills';
import { CareerStore } from '../store';
import { createMemoryRepos } from '../test-db';
import type { TailorRunner } from '../tailor-for-job';
import type { DrafterDeps } from './drafter';

export const PERSON = { name: '张三', phone: '13800001111', school: '华东大学', major: '计算机科学', graduation: '2027-06', email: 'zhangsan@163.com' };

/** 一份够长、带「职责 / 要求」的 JD（hasRealJd 认得出，会按岗位定制）；写了投递邮箱。 */
export function internJd(company: string, domain: string, extra = ''): string {
  return `${company} 产品实习生\n岗位职责：参与需求分析、竞品调研与数据分析。\n任职要求：每周到岗 4 天以上，可实习 3 个月以上。\n简历投递至 hr@${domain}.com ${extra}`;
}

export interface MailFixture {
  dir: string;
  repos: Repos;
  store: CareerStore;
  vault: Vault;
  llm: FakeLLM;
  /** 起草器的依赖，外加私密库缺项检查（开始投时用，不碰本机真实私密库）。 */
  deps: DrafterDeps & { vaultUnresolved: (text: string) => string[] };
  tailorCalls: string[];
}

/** 假定制：建一份定制版（改 2 处），和真的一样挂在岗位上。 */
function fakeTailor(store: CareerStore, calls: string[]): TailorRunner {
  return async ({ jobId, masterId }) => {
    calls.push(jobId);
    const master = store.getResume(masterId);
    if (master?.kind !== 'master') throw new Error(`主简历不存在：${masterId}`);
    const t = store.createTailored({ master_id: masterId, job_id: jobId, schema_json: JSON.parse(master.row.schema_json) });
    return { tailored_id: t.id, changes: 2 };
  };
}

export type FixtureProfile = Partial<Record<keyof typeof PERSON, string>> | null;

export async function mailFixture(dir: string, opts: { profile?: FixtureProfile } = {}): Promise<MailFixture> {
  const core = await loadCore();
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, core);
  const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7)));
  const profile: Record<string, string | undefined> = opts.profile === null ? {} : { ...PERSON, ...opts.profile };
  for (const [field, value] of Object.entries(profile)) if (value) vault.set({ scope: 'profile', field, value });
  const llm = new FakeLLM();
  const tailorCalls: string[] = [];
  const exportPdf = async (id: string) => { const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${id}`); return p; };
  const deps: MailFixture['deps'] = { repos, store, exportPdf, exportsDir: dir, vault, vaultUnresolved: text => vault.unresolved(text), askSkill: backgroundAskSkill(llm, core), tailor: fakeTailor(store, tailorCalls), draftTimeoutMs: 1000 };
  return { dir, repos, store, vault, llm, deps, tailorCalls };
}

/** 模型写的前两段（derivatives 技能在邮件投递模式下的输出）。 */
export function modelMail(opts: { subject?: string; body?: string; attachment?: string } = {}): string {
  return JSON.stringify({ email: { subject: opts.subject ?? '', body: opts.body ?? '您好！我是华东大学计算机科学专业 2027 届学生，应聘贵司产品实习生。\n我做过三次竞品调研，搭过一份周报看板。', signature: '' }, attachment_name: opts.attachment ?? '', short_message: '' });
}
