import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsSection } from '../settingsSections';

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  setActiveSection: Dispatch<SetStateAction<SettingsSection>>;
  showDevTools?: boolean;
  floatingBallDevGate?: boolean;
  onShowLogs: () => void;
}

/**
 * 求职助理用户端只保留通用 / 外观 / 关于类设置。模型供应商、聊天机器人 Bot、
 * 使用统计、外部调用等模型 / 运行时相关分区不再出现在导航里（内置国内模型零配置）。
 */
const NAV_ITEMS: Array<{ section: SettingsSection; labelKey: string }> = [
  { section: 'general', labelKey: 'sidebar.nav.general' },
  { section: 'desktop-pet', labelKey: 'sidebar.nav.floatingBall' },
  { section: 'proxy', labelKey: 'sidebar.nav.proxy' },
  { section: 'shortcuts', labelKey: 'sidebar.nav.shortcuts' },
  { section: 'about', labelKey: 'sidebar.nav.about' },
];

export function SettingsSidebar({
  activeSection,
  setActiveSection,
  showDevTools,
  floatingBallDevGate,
  onShowLogs,
}: SettingsSidebarProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="settings-sidebar w-52 shrink-0 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--ink)]">{t('sidebar.title')}</h1>
        {showDevTools && (
          <button
            onClick={onShowLogs}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:bg-[var(--inset)] hover:text-[var(--ink)]"
            title={t('sidebar.logsTitle')}
          >
            Logs
          </button>
        )}
      </div>

      <nav className="settings-nav overflow-x-auto space-y-1">
        {NAV_ITEMS.map((item) => {
          if (item.section === 'desktop-pet' && floatingBallDevGate === false) return null;
          const isActive = item.section === activeSection;
          return (
            <button
              key={item.section}
              onClick={() => setActiveSection(item.section)}
              className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${
                isActive
                  ? 'settings-nav-active bg-[var(--hover)] text-[var(--ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
