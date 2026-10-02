// Builtin-edition Tab model and shared constructors.

import type { ChatTab, InitialMessage, SidecarConfigDisposition } from '@/features/chat/tabContract';
import type { LauncherTab } from '@/features/launcher/tabContract';
import type { SettingsTab } from '@/features/settings/tabContract';
import type { CapabilitiesTab } from '@/features/capabilities/tabContract';
import type { TaskCenterTab } from '@/features/task-center/tabContract';
import type { SpaceTab } from '@/features/space/tabContract';
import type { RecordTab } from '@/features/record/tabContract';
import type { CareerExperienceTab } from '@/features/career-experience/tabContract';
import type { CareerResumeTab } from '@/features/career-resume/tabContract';
import type { CareerApplyTab } from '@/features/career-apply/tabContract';
import type { CareerResearchTab } from '@/features/career-research/tabContract';
import type { CareerInterviewTab } from '@/features/career-interview/tabContract';
import type { CareerOfferTab } from '@/features/career-offer/tabContract';

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
export type { CareerExperienceTab } from '@/features/career-experience/tabContract';
export type { CareerResumeTab } from '@/features/career-resume/tabContract';
export type { CareerApplyTab } from '@/features/career-apply/tabContract';
export type { CareerResearchTab } from '@/features/career-research/tabContract';
export type { CareerInterviewTab } from '@/features/career-interview/tabContract';
export type { CareerOfferTab } from '@/features/career-offer/tabContract';

/** 求职助理六个一级功能页的 Tab 种类（单实例）。 */
export type CareerPageTab =
  | CareerExperienceTab
  | CareerResumeTab
  | CareerApplyTab
  | CareerResearchTab
  | CareerInterviewTab
  | CareerOfferTab;
export type CareerPageKind = CareerPageTab['view'];
export const CAREER_PAGE_KINDS: readonly CareerPageKind[] = [
  'career-experience',
  'career-resume',
  'career-apply',
  'career-research',
  'career-interview',
  'career-offer',
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
