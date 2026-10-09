import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CareerNavShell } from './CareerNavShell';
import { locateNav, NAV_AREAS } from './navModel';
import { resetCareerSubViews, setCareerSubView } from './subViewStore';

describe('navModel', () => {
  it('lists the five areas plus settings, and L2 never repeats the area name', () => {
    expect(NAV_AREAS.map(area => area.label)).toEqual(['工作台', '对话', '我的求职', '功能市场', '我的资料', '设置']);
    for (const area of NAV_AREAS) {
      expect(area.items.map(item => item.label)).not.toContain(area.label);
    }
    expect(NAV_AREAS.find(area => area.id === 'career')!.items.map(item => item.label))
      .toEqual(['岗位收藏', '投递记录', '笔试记录', '面试记录']);
    expect(NAV_AREAS.find(area => area.id === 'assets')!.items.map(item => item.label))
      .toEqual(['基本资料', '经历', '简历', '常用表达']);
  });

  it('locates the area and item from the active tab and the page sub-view', () => {
    expect(locateNav('chat', {})).toEqual({ area: 'chat', itemId: null });
    expect(locateNav('career-guide', {})).toEqual({ area: 'market', itemId: null });
    expect(locateNav('career-today', {})).toEqual({ area: 'work', itemId: 'today' });
    expect(locateNav('career-dossier', { 'career-dossier': 'apply' })).toEqual({ area: 'career', itemId: 'saved' });
    expect(locateNav('career-dossier', { 'career-dossier': 'interview' })).toEqual({ area: 'career', itemId: 'interviews' });
    expect(locateNav('career-material', { 'career-material': 'resume' })).toEqual({ area: 'assets', itemId: 'resumes' });
    expect(locateNav('settings', {})).toEqual({ area: 'settings', itemId: null });
  });
});

describe('CareerNavShell', () => {
  beforeEach(() => {
    resetCareerSubViews();
    try { localStorage.clear(); } catch { /* storage unavailable in this runtime */ }
  });

  it('shows no L2 column for the chat area', () => {
    render(<CareerNavShell activeView="chat" onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /对话/ })).toHaveAttribute('aria-current', 'page');
    expect(document.querySelector('[data-career-subnav]')).toBeNull();
  });

  it('marks the L2 item that matches the page sub-view', () => {
    act(() => { setCareerSubView('career-dossier', 'interview'); });
    render(<CareerNavShell activeView="career-dossier" onOpen={vi.fn()} />);
    const subnav = screen.getByRole('navigation', { name: '我的求职' });
    expect(within(subnav).getByRole('button', { name: '面试记录' })).toHaveAttribute('aria-current', 'page');
    expect(within(subnav).getByRole('button', { name: '投递记录' })).not.toHaveAttribute('aria-current');
  });

  it('opens the target of an L2 item and of an area without sub-pages', () => {
    const onOpen = vi.fn();
    render(<CareerNavShell activeView="career-dossier" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: '岗位收藏' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'career-dossier', view: 'apply' });
    fireEvent.click(screen.getByRole('button', { name: /功能市场/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'career-guide' });
  });

  it('opens the first L2 item when entering an area for the first time', () => {
    const onOpen = vi.fn();
    render(<CareerNavShell activeView="chat" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /我的资料/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'career-vault' });
  });

  it('collapses and restores L2 with the keyboard shortcut', () => {
    render(<CareerNavShell activeView="career-today" onOpen={vi.fn()} />);
    expect(document.querySelector('[data-career-subnav="work"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'b', metaKey: true, ctrlKey: true });
    expect(document.querySelector('[data-career-subnav]')).toBeNull();
    fireEvent.keyDown(window, { key: 'b', metaKey: true, ctrlKey: true });
    expect(document.querySelector('[data-career-subnav="work"]')).not.toBeNull();
  });
});
