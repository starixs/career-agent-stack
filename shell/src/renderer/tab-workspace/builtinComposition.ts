import { createNewTab, type Tab } from '@/types/tab';
import type { ModuleBinding, ModuleTab } from '@/tab-workspace/contracts';
import { defineTabModules } from '@/tab-workspace/registry';
import type { TabLifecycleAdapter } from '@/tab-workspace/useTabCloseController';
import { launcherTabModule } from '@/features/launcher/tabModule';
import { chatTabModule } from '@/features/chat/tabModule';
import { settingsTabModule } from '@/features/settings/tabModule';
import { capabilitiesTabModule } from '@/features/capabilities/tabModule';
import { taskCenterTabModule } from '@/features/task-center/tabModule';
import { spaceTabModule } from '@/features/space/tabModule';
import { recordTabModule } from '@/features/record/tabModule';
import { careerTodayTabModule } from '@/features/career-today/tabModule';
import { careerInboxTabModule } from '@/features/career-inbox/tabModule';
import { careerDossierTabModule } from '@/features/career-dossier/tabModule';
import { careerMaterialTabModule } from '@/features/career-material/tabModule';
import { careerReviewTabModule } from '@/features/career-review/tabModule';
import { careerGuideTabModule } from '@/features/career-guide/tabModule';
import { careerLiveTabModule } from '@/features/career-live/tabModule';
import { careerVaultTabModule } from '@/features/career-vault/tabModule';
import type { RecordTabCloseReason } from '@/features/record/useRecordTabLifecycle';

/** The single composition root for the builtin keystone edition. */
export const builtinTabModules = defineTabModules<Tab>()({
  launcher: launcherTabModule,
  chat: chatTabModule,
  settings: settingsTabModule,
  capabilities: capabilitiesTabModule,
  taskcenter: taskCenterTabModule,
  space: spaceTabModule,
  record: recordTabModule,
  'career-today': careerTodayTabModule,
  'career-inbox': careerInboxTabModule,
  'career-dossier': careerDossierTabModule,
  'career-material': careerMaterialTabModule,
  'career-review': careerReviewTabModule,
  'career-guide': careerGuideTabModule,
  'career-live': careerLiveTabModule,
  'career-vault': careerVaultTabModule,
});

export type BuiltinTabModules = typeof builtinTabModules;

/** Runtime bindings are derived from the same closed definition map. App must
 * inject values through this composition boundary instead of declaring a
 * second hand-maintained kind/type map. */
export type BuiltinTabBindings = {
  readonly [K in keyof BuiltinTabModules]: ModuleBinding<BuiltinTabModules[K]>;
};

export function composeBuiltinTabBindings(bindings: BuiltinTabBindings): BuiltinTabBindings {
  return bindings;
}

export type BuiltinTabCloseReason = RecordTabCloseReason;

export type BuiltinTabLifecycle = {
  readonly [K in keyof BuiltinTabModules]?: TabLifecycleAdapter<
    ModuleTab<BuiltinTabModules[K]>,
    BuiltinTabCloseReason
  >;
};

export function composeBuiltinTabLifecycle(lifecycle: BuiltinTabLifecycle): BuiltinTabLifecycle {
  return lifecycle;
}

/** Edition-owned policy that the generic workspace deliberately cannot infer.
 *
 * 求职助理是单一对话产品：唯一的个人助理 Chat Tab 受保护不可关闭；关掉其他功能页
 * 后回到 Chat 而不是启动页。`createFallback` 只在工作区被清空时才会真正新建一个
 * 启动页（它随后由 App 的单会话启动流程翻成 Chat）。 */
export const builtinTabWorkspacePolicy = Object.freeze({
  createFallback: createNewTab,
  isLastTabProtected: (tab: Tab) => tab.view === 'chat' || tab.view === 'launcher',
  defaultCloseReason: 'user' as BuiltinTabCloseReason,
});
