/**
 * 邮件起草器的 Global 装配（batch-service.ts resumeBatchIfRunning 调一次）：
 * 共享模型 + 技能提示词、私密库、导 PDF 的材料包依赖；装好后先把重启前卡住的放回队列，再开始轮询。
 * 动态加载：模型与导出链路较重，不拖慢侧车冷启动。
 */
import type { PacketDeps } from '../packets';
import { draftMailForAction, type DrafterDeps } from './drafter';
import { installMailDrafter, MailDrafter } from './runner';

let started = false;

async function drafterDeps(packetDeps: () => Promise<PacketDeps>): Promise<DrafterDeps> {
  const [base, { getVault }, { getShellLLM }, { backgroundAskSkill }, { loadCore }] = await Promise.all([
    packetDeps(), import('../vault'), import('../llm'), import('../skills'), import('../core-module'),
  ]);
  const [vault, core] = await Promise.all([getVault(), loadCore()]);
  return { ...base, vault, askSkill: backgroundAskSkill(getShellLLM(), core) };
}

/** 启动邮件起草器（幂等）。 */
export async function startMailDrafterService(packetDeps: () => Promise<PacketDeps>): Promise<void> {
  if (started) return;
  started = true;
  const { getRepos } = await import('../db');
  const repos = await getRepos();
  const drafter = new MailDrafter({ repos, draft: async action => draftMailForAction(await drafterDeps(packetDeps), action) });
  installMailDrafter(drafter);
  drafter.recover();
  drafter.start();
  console.log('[career] mail-apply drafter started');
}
