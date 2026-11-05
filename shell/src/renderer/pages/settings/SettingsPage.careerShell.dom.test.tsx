import {
  fireEvent,
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

  it("关于页只有产品名、版本、反馈和隐私说明，没有 keystone 底座的内容", async () => {
    const { container } = renderSettings("about");
    expect(await screen.findByText(zh("about.careerPrivacy"))).toBeInTheDocument();
    expect(screen.getByText("求职助理")).toBeInTheDocument();
    const text = container.textContent ?? "";
    for (const leftover of ["keystone", "Claude Agent SDK", "内部研发", "Your intent, amplified", "Team Space", "dev@internal.local"]) {
      expect(text).not.toContain(leftover);
    }
    fireEvent.click(screen.getByRole("button", { name: zh("about.careerFeedbackAction") }));
    expect(await screen.findByText(String(i18n.t("titlebar.helper", { ns: "app" })))).toBeInTheDocument();
  });

  it("通用设置不露服务端、工作区和队列模式；预置了模型 Key 就不露 Key 面板", async () => {
    renderSettings("general");
    expect(await screen.findByText(zh("general.forceWakeTitle"))).toHaveTextContent("别让电脑睡着");
    await waitFor(() => expect(screen.queryByTestId("settings-career-keys")).not.toBeInTheDocument());
    expect(screen.queryByTestId("settings-career-server")).not.toBeInTheDocument();
    expect(screen.queryByText(zh("general.defaultWorkspaceTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("general.queueTitle"))).not.toBeInTheDocument();
  });

  it("缺模型 Key 时才露出 Key 面板，而且只要模型 Key", async () => {
    settingsMocks.llmConfigured = false;
    renderSettings("general");
    expect(await screen.findByTestId("settings-career-keys")).toBeInTheDocument();
    expect(screen.getByLabelText("模型 API Key")).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索 API Key")).not.toBeInTheDocument();
  });

  it("快捷键只留发送键；桌面宠物分区落到关于", async () => {
    const { unmount } = renderSettings("shortcuts");
    expect(await screen.findByText(zh("shortcuts.messageSend.title"))).toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.summon.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.app.items.new-tab"))).not.toBeInTheDocument();
    expect(screen.queryByText(zh("shortcuts.app.items.cycle-tab"))).not.toBeInTheDocument();
    unmount();
    renderSettings("desktop-pet");
    expect(await screen.findByText(zh("about.careerPrivacy"))).toBeInTheDocument();
  });

  it("keystone 壳保留底座原样的关于页和服务端面板", async () => {
    const { unmount } = renderSettings("about", "keystone");
    expect(await screen.findByText("keystone")).toBeInTheDocument();
    expect(screen.getByText(zh("about.labTitle"))).toBeInTheDocument();
    unmount();
    renderSettings("general", "keystone");
    expect(await screen.findByTestId("settings-career-server")).toBeInTheDocument();
  });
});
