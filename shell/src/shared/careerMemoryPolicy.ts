/**
 * 求职产品不用基座的工作区记忆（keystone 记忆巩固 / gardener / molt）与定时心跳：
 *  - 它们靠模型写 `.claude/rules/*.md`、跑 python / git，而求职产品禁掉了 Write / Edit / Bash / Task（决策 2），
 *    所以每次都失败；还会把隐藏轮插进用户唯一的主对话，污染转录与上下文。
 *  - 记忆改由求职数据库的 memory 表承担（模型提议、代码把关、后台巩固，不进对话）。
 *
 * 这里把已有配置里还开着的三项关掉；现有的任务对账（reconcileMemory*Tasks / 心跳调度）看到关闭会自己撤掉后台任务。
 * 返回是否改动（调用方据此持久化）。
 */
export interface LegacyMemoryAgentFields {
  heartbeat?: { enabled?: boolean };
  memoryAutoUpdate?: { enabled?: boolean };
  memoryEvolution?: { enabled?: boolean };
}

export function retireLegacyMemoryJobs(agents: LegacyMemoryAgentFields[] | undefined): boolean {
  if (!agents?.length) return false;
  let changed = false;
  for (const agent of agents) {
    for (const key of ['heartbeat', 'memoryAutoUpdate', 'memoryEvolution'] as const) {
      const section = agent[key];
      if (section?.enabled) {
        agent[key] = { ...section, enabled: false };
        changed = true;
      }
    }
  }
  return changed;
}
