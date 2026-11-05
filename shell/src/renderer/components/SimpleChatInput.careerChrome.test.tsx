import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import { i18n } from '@/i18n';
import SimpleChatInput from './SimpleChatInput';
import { ToastProvider } from './Toast';

// 求职壳的输入框只留回形针、输入框、发送（beta-polish ③）。不 mock composerChrome，用的是真实开关。

const workspaceService = vi.hoisted(() => ({
  isAvailable: true,
  importBase64Files: vi.fn(),
  copyPaths: vi.fn(),
  addGitignore: vi.fn(),
  prepareUserImageAttachments: vi.fn(),
  searchFiles: vi.fn(async () => []),
  listSlashCommands: vi.fn(async () => []),
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { chatSendShortcut: 'enter' } }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => workspaceService,
}));

function renderCareerInput() {
  render(
    <ToastProvider>
      <ImagePreviewProvider>
        <SimpleChatInput
          runtime="builtin"
          isLoading={false}
          onSend={vi.fn()}
          permissionMode="auto"
          onPermissionModeChange={vi.fn()}
          onCronButtonClick={vi.fn()}
          contextIndicator={<span data-testid="context-ring" />}
          sdkSlashCommands={[{ name: 'compact', description: 'compact', source: 'builtin' }]}
        />
      </ImagePreviewProvider>
    </ToastProvider>,
  );
}

describe('SimpleChatInput in the career shell', () => {
  it('keeps only the attach-file control: no plus menu, permission mode, tools or context ring', async () => {
    await i18n.changeLanguage('zh-CN');
    renderCareerInput();

    expect(screen.getByRole('button', { name: '上传文件' })).toBeInTheDocument();
    expect(screen.queryByTitle('添加上下文')).not.toBeInTheDocument();
    expect(screen.queryByTitle('切换执行模式')).not.toBeInTheDocument();
    expect(screen.queryByTitle('使用工具')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-ring')).not.toBeInTheDocument();
    expect(screen.queryByText('使用技能')).not.toBeInTheDocument();
    expect(screen.queryByText('定时任务')).not.toBeInTheDocument();
  });

  it('does not open the slash-command or workspace-file pickers while typing', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup();
    renderCareerInput();

    const textarea = screen.getByPlaceholderText('跟小芽说说，或者把简历拖进来…');
    await user.type(textarea, '@');
    expect(screen.queryByText('输入文件名搜索...')).not.toBeInTheDocument();
    await user.type(textarea, ' /');
    expect(screen.queryByText('/compact')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('@ /');
  });
});
