import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const seen: Array<{ initialSection?: string }> = [];
vi.mock('@/pages/Settings', () => ({
  default: (props: { initialSection?: string }) => {
    seen.push({ initialSection: props.initialSection });
    return <div data-testid="settings" />;
  },
}));

import type { SettingsRenderBinding } from './tabModule';
import { settingsTabModule } from './tabModule';

const Renderer = settingsTabModule.render;
const binding = { onNavigationConsumed: vi.fn() } as unknown as SettingsRenderBinding;

describe('settings tab module', () => {
  it('passes no section once the navigation intent has been consumed', async () => {
    const { rerender } = render(
      <Renderer tab={{ id: 't1', view: 'settings', title: '设置', navigationIntent: { generation: 1, section: 'proxy' } }} isActive isDeferred={false} binding={binding} />,
    );
    await screen.findByTestId('settings');
    expect(seen.at(-1)?.initialSection).toBe('proxy');

    // A consumed intent must not turn into a fallback section, or the page jumps away from what the user picked.
    rerender(<Renderer tab={{ id: 't1', view: 'settings', title: '设置' }} isActive isDeferred={false} binding={binding} />);
    expect(seen.at(-1)?.initialSection).toBeUndefined();
  });
});
