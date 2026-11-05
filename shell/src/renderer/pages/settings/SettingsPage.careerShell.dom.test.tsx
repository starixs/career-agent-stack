import {
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

import { ToastProvider } from "@/components/Toast";
import { DEFAULT_CONFIG, type AppConfig, type Provider } from "@/config/types";
import Settings from "./SettingsPage";

const settingsMocks = vi.hoisted(() => ({
  linux: true,
  config: {} as AppConfig,
  atomicModifyConfig: vi.fn(),
  patchProxySettings: vi.fn(),
  refreshConfig: vi.fn(),
  apiPostJson: vi.fn(),
  invoke: vi.fn(),
  llmConfigured: true,
}));

const visionProvider = {
  id: "vision-provider",
  name: "Vision Provider",
  vendor: "Test",
  cloudProvider: "模型官方",
  type: "api",
  primaryModel: "vision-model",
  isBuiltin: false,
  config: { baseUrl: "https://example.invalid" },
  models: [
    {
      model: "vision-model",
      modelName: "Vision Model",
      modelSeries: "test",
      inputModalities: ["text", "image"],
    },
  ],
} as Provider;
const stableProviders = [visionProvider];
const stableProjects: never[] = [];
const stableApiKeys = { "vision-provider": "configured-key" };
const stableVerifyStatus = {};
const configNoop = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: settingsMocks.invoke }));
vi.mock("@/components/MonacoEditor", () => ({ default: () => null }));
vi.mock("@/components/SettingsHelperInbox", () => ({ default: () => null }));
vi.mock("@/components/UnifiedLogsPanel", () => ({
  UnifiedLogsPanel: () => null,
}));
vi.mock("@/components/WorkspaceConfigPanel", () => ({ default: () => null }));
vi.mock("@/components/GlobalPluginsPanel", () => ({ default: () => null }));
vi.mock("@/components/dev/CronTaskDebugPanel", () => ({ default: () => null }));
vi.mock("@/components/ImSettings", () => ({ BotPlatformRegistry: () => null }));

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({
    apiKeys: stableApiKeys,
    saveApiKey: configNoop,
    deleteApiKey: configNoop,
    providerVerifyStatus: stableVerifyStatus,
    saveProviderVerifyStatus: configNoop,
    config: settingsMocks.config,
    updateConfig: configNoop,
    patchProxySettings: settingsMocks.patchProxySettings,
    providers: stableProviders,
    projects: stableProjects,
    addProject: configNoop,
    updateProject: configNoop,
    addCustomProvider: configNoop,
    updateCustomProvider: configNoop,
    deleteCustomProvider: configNoop,
    refreshProviders: configNoop,
    savePresetCustomModels: configNoop,
    removePresetCustomModel: configNoop,
    savePrimaryModel: configNoop,
    saveProviderModelAliases: configNoop,
    refreshConfig: settingsMocks.refreshConfig,
    managedCodexRuntimeUpdateInFlight: false,
    requestManagedCodexRuntimeUpdate: configNoop,
  }),
}));

vi.mock("@/config/configService", async () => {
  const actual = await vi.importActual<typeof import("@/config/configService")>(
    "@/config/configService",
  );
  return {
    ...actual,
    atomicModifyConfig: settingsMocks.atomicModifyConfig,
    getAllMcpServers: vi.fn().mockResolvedValue([]),
    getEnabledMcpServerIds: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/api/apiFetch", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  apiGetJson: vi.fn(async (path: string) => path === "/api/career/setup"
    ? { ok: true, setup: { llm: { configured: settingsMocks.llmConfigured, source: settingsMocks.llmConfigured ? "build" : "none" },
      search: { configured: false, source: "none", provider: null } } }
    : { success: true, data: {} }),
  apiPostJson: settingsMocks.apiPostJson,
  apiPutJson: vi.fn(),
}));

vi.mock("@/hooks/useSpaceBuildCapability", () => ({
  useSpaceBuildCapability: () => ({
    activeEnvironment: "production",
    environments: ["production"],
  }),
}));

vi.mock("@/hooks/useAutostart", () => ({
  useAutostart: () => ({
    isEnabled: false,
    isLoading: false,
    setAutostart: vi.fn(),
  }),
}));

vi.mock("@/hooks/useHelperAgentModelDefaults", () => ({
  useHelperAgentModelDefaults: () => ({}),
}));

vi.mock("@/theme", async () => {
  const actual = await vi.importActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useResolvedTheme: () => ({ id: "warm-paper" }) };
});

vi.mock("@/api/recording", () => ({
  speechModelPackInstall: vi.fn(),
  speechModelPackRemove: vi.fn(),
  speechModelPackStatus: vi.fn().mockResolvedValue(null),
}));


vi.mock('@/utils/desktopPlatform', () => ({
  isLinuxDesktop: () => settingsMocks.linux,
  getPlatformHiddenProviderIds: () => settingsMocks.linux ? ['codex-sub', 'antigravity-sub'] : [],
}));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));

const zh = (key: string) => String(i18n.t(key, { ns: "settings" }));

function renderSettings(section: string, shell?: "career" | "keystone") {
  return render(<ToastProvider><Settings mode="settings" initialSection={section} isActive shell={shell} /></ToastProvider>);
}

describe("求职壳里的设置页（beta-polish ⑥）", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsMocks.linux = false;
    settingsMocks.llmConfigured = true;
    settingsMocks.config = { ...DEFAULT_CONFIG, agents: [], floatingBallDevGate: true };
    settingsMocks.invoke.mockResolvedValue(undefined);
    settingsMocks.apiPostJson.mockResolvedValue({ success: true, data: {} });
    await i18n.changeLanguage("zh-CN");
  });

  it("关于页只有产品名、版本和检查更新，没有反馈卡、隐私说明和 keystone 底座的内容", async () => {
    const { container } = renderSettings("about");
    expect(await screen.findByText("求职助理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh("about.checkUpdates") })).toBeInTheDocument();
    const text = container.textContent ?? "";
    for (const leftover of ["keystone", "Claude Agent SDK", "内部研发", "Your intent, amplified", "Team Space", "dev@internal.local", "去反馈", "只存在你的电脑上"]) {
      expect(text).not.toContain(leftover);
    }
  });

  it("帮助与反馈：小助理一行，不带解释句", async () => {
    const { container } = renderSettings("feedback");
    expect(await screen.findByText(String(i18n.t("titlebar.helper", { ns: "app" })))).toBeInTheDocument();
    expect(screen.getByText(String(i18n.t("titlebar.feedbackTitle", { ns: "app" })))).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain("都可以找小助理");
  });

  it("通用设置不露服务端、工作区、队列模式、模型 Key 和通用「一直不睡」", async () => {
    renderSettings("general");
    expect(await screen.findByRole("switch", { name: "投递时保持屏幕常亮" })).toBeInTheDocument();
    expect(screen.queryByText(zh("general.forceWakeTitle"))).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("settings-career-keys")).not.toBeInTheDocument());
    expect(screen.queryByTestId("settings-career-server")).not.toBeInTheDocument();
    expect(screen.queryByText(zh("general.defaultWorkspaceTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("general.queueTitle"))).not.toBeInTheDocument();
    // 设置行只有标题和控件，不逐行解释。
    for (const key of ["general.description", "general.autostartDescription", "general.minimizeToTrayDescription", "general.languageDescription", "general.appearanceModeDescription", "general.markdownReadingSizeDescription", "general.logsDescription"]) {
      expect(screen.queryByText(zh(key))).not.toBeInTheDocument();
    }
    expect(screen.getByText(zh("general.autostartTitle"))).toBeInTheDocument();
  });

  it("快捷键只留发送键；桌面宠物分区落到关于", async () => {
    const { unmount } = renderSettings("shortcuts");
    expect(await screen.findByText(zh("shortcuts.messageSend.shortcutTitle"))).toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.messageSend.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.messageSend.enterSummary"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.summon.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.app.items.new-tab"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.app.items.cycle-tab"))).not.toBeInTheDocument();
    unmount();
    renderSettings("desktop-pet");
    expect(await screen.findByRole("button", { name: zh("about.checkUpdates") })).toBeInTheDocument();
  });

  it("keystone 壳保留底座原样的关于页和服务端面板", async () => {
    const { unmount } = renderSettings("about", "keystone");
    expect(await screen.findByText("keystone")).toBeInTheDocument();
    expect(screen.getByText(zh("about.labTitle"))).toBeInTheDocument();
    unmount();
    renderSettings("general", "keystone");
    expect(await screen.findByTestId("settings-career-server")).toBeInTheDocument();
    expect(screen.getByText(zh("general.autostartDescription"))).toBeInTheDocument();
  });
});
