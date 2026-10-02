// Builtin-edition Tab model and shared constructors.

import type { ChatTab, InitialMessage, SidecarConfigDisposition } from '@/features/chat/tabContract';
import type { LauncherTab } from '@/features/launcher/tabContract';
import type { SettingsTab } from '@/features/settings/tabContract';
import type { CapabilitiesTab } from '@/features/capabilities/tabContract';
import type { TaskCenterTab } from '@/features/task-center/tabContract';
import type { SpaceTab } from '@/features/space/tabContract';
import type { RecordTab } from '@/features/record/tabContract';
import type { CareerTodayTab } from '@/features/career-today/tabContract';
import type { CareerInboxTab } from '@/features/career-inbox/tabContract';
import type { CareerDossierTab } from '@/features/career-dossier/tabContract';
import type { CareerMaterialTab } from '@/features/career-material/tabContract';
import type { CareerReviewTab } from '@/features/career-review/tabContract';
import type { CareerGuideTab } from '@/features/career-guide/tabContract';

export type { TabBase } from '@/tab-workspace/contracts';
export type {
  ChatTab,
  FilePreviewIntent,
  InitialMessage,
  InitialMessageCron,
  LaunchSessionBirthHint,
  SidecarConfigDisposition,
} from '@/features/chat/tabContract';
export type { LauncherTab } from '@/features/launcher/tabContract';
export type { SettingsNavigationIntent, SettingsTab } from '@/features/settings/tabContract';
export type {
  CapabilitiesNavigationIntent,
  CapabilitiesTab,
  CapabilitySection,
} from '@/features/capabilities/tabContract';
export type { TaskCenterSearchIntent, TaskCenterTab } from '@/features/task-center/tabContract';
export type { SpaceTab } from '@/features/space/tabContract';
export type { RecordTab } from '@/features/record/tabContract';
export type { CareerTodayTab } from '@/features/career-today/tabContract';
export type { CareerInboxTab } from '@/features/career-inbox/tabContract';
export type { CareerDossierTab } from '@/features/career-dossier/tabContract';
export type { CareerMaterialTab } from '@/features/career-material/tabContract';
export type { CareerReviewTab } from '@/features/career-review/tabContract';
export type { CareerGuideTab } from '@/features/career-guide/tabContract';

/** 求职工作台五个面 + 指南的 Tab 种类（单实例）；清单以 features/career-shared/nav.ts 为准。 */
export type CareerPageTab =
  | CareerTodayTab
  | CareerInboxTab
  | CareerDossierTab
  | CareerMaterialTab
  | CareerReviewTab
  | CareerGuideTab;
export type CareerPageKind = CareerPageTab['view'];
export const CAREER_PAGE_KINDS: readonly CareerPageKind[] = [
  'career-today',
  'career-inbox',
  'career-dossier',
  'career-material',
  'career-review',
  'career-guide',
];

/** Closed union for the builtin career-assistant edition. Downstream editions
 * extend their own closed union and composition explicitly. The Launcher kind
 * only survives as the boot surface before the single assistant Chat is bound. */
export type Tab =
  | LauncherTab
  | ChatTab
  | SettingsTab
  | CapabilitiesTab
  | TaskCenterTab
  | SpaceTab
  | RecordTab
  | CareerPageTab;

export type TabKind = Tab['view'];
export type TabOf<K extends TabKind> = Extract<Tab, { view: K }>;

export interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
}

export const MAX_TABS = 12;

export function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateSessionTitle(firstMessage: string): string {
  const maxLength = 20;
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New Chat';
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

export function getFolderName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function createNewTab(): LauncherTab {
  return {
    id: generateTabId(),
    view: 'launcher',
    title: 'New Tab',
  };
}

/** 单一对话：工作区里唯一的个人助理 Chat Tab（若尚未绑定则返回 undefined）。 */
export function findAssistantChatTab(tabs: readonly Tab[]): ChatTab | undefined {
  return tabs.find((tab): tab is ChatTab => tab.view === 'chat');
}

/** 单一对话的回退 Tab：优先回到既有 Chat，其次是启动页；没有可复用 Tab 时才新建启动页。 */
export function createSingleSessionFallback(tabs: readonly Tab[]): Tab {
  return findAssistantChatTab(tabs) ?? tabs.find((tab) => tab.view === 'launcher') ?? createNewTab();
}

/** Canonical, type-safe transition from an existing shell Tab to Chat. */
export function buildChatFlipPatch(
  tab: Tab,
  fields: {
    agentDir: string;
    sessionId: string;
    title: string;
    initialMessage?: InitialMessage;
    sidecarConfigDisposition: SidecarConfigDisposition;
  },
): ChatTab {
  if (!fields.sessionId) {
    throw new Error(
      'buildChatFlipPatch: sessionId must be a non-empty id (D1) — flipping to chat without one strands the tab',
    );
  }
  const initialMessage = fields.initialMessage ?? (tab.view === 'chat' ? tab.initialMessage : undefined);
  return {
    id: tab.id,
    agentDir: fields.agentDir,
    sessionId: fields.sessionId,
    view: 'chat',
    title: fields.title,
    ...(initialMessage ? { initialMessage } : {}),
    sidecarConfigDisposition: fields.sidecarConfigDisposition,
    ...(tab.view === 'chat'
      ? {
          isGenerating: tab.isGenerating,
          hasUnread: tab.hasUnread,
          pendingFilePreview: tab.pendingFilePreview,
        }
      : {}),
  };
}
