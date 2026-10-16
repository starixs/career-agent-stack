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
    // 工作台只有两项：任务中心不再出现在这里
    const work = NAV_AREAS.find(area => area.id === 'work')!.items;
    expect(work.map(item => item.label)).toEqual(['招聘概览', '通知中心']);
    expect(work.map(item => item.target.kind)).toEqual(['career-today', 'career-inbox']);
    expect(NAV_AREAS.find(area => area.id === 'career')!.items.map(item => item.label))
      .toEqual(['岗位收藏', '投递记录', '助力记录']);
    expect(NAV_AREAS.find(area => area.id === 'assets')!.items.map(item => item.label))
      .toEqual(['基本资料', '简历']);
    expect(NAV_AREAS.find(area => area.id === 'settings')!.items.map(item => item.id))
      .toEqual(['general', 'desktop-pet', 'shortcuts', 'capabilities', 'feedback', 'about']);
  });

  it('locates the area and item from the active tab and the page sub-view', () => {
    expect(locateNav('chat', {})).toEqual({ area: 'chat', itemId: null });
    expect(locateNav('career-guide', {})).toEqual({ area: 'market', itemId: null });
    expect(locateNav('career-today', {})).toEqual({ area: 'work', itemId: 'today' });
    expect(locateNav('career-inbox', {})).toEqual({ area: 'work', itemId: 'inbox' });
    expect(locateNav('taskcenter', {})).toEqual({ area: 'work', itemId: null });
    expect(locateNav('record', {})).toEqual({ area: 'work', itemId: null });
    expect(locateNav('launcher', {})).toEqual({ area: 'chat', itemId: null });
    expect(locateNav('career-dossier', { 'career-dossier': 'apply' })).toEqual({ area: 'career', itemId: 'saved' });
    expect(locateNav('career-dossier', { 'career-dossier': 'assist' })).toEqual({ area: 'career', itemId: 'assists' });
    // 面试工作台和 Offer 对比只从功能市场打开
    expect(locateNav('career-dossier', { 'career-dossier': 'interview' })).toEqual({ area: 'market', itemId: null });
    expect(locateNav('career-material', { 'career-material': 'resume' })).toEqual({ area: 'assets', itemId: 'resumes' });
    expect(locateNav('career-dossier', { 'career-dossier': 'offer' })).toEqual({ area: 'market', itemId: null });
    expect(locateNav('career-review', {})).toEqual({ area: 'market', itemId: null });
    expect(locateNav('settings', {})).toEqual({ area: 'settings', itemId: 'general' });
    expect(locateNav('settings', { settings: 'feedback' })).toEqual({ area: 'settings', itemId: 'feedback' });
    expect(locateNav('capabilities', {})).toEqual({ area: 'settings', itemId: 'capabilities' });
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
    act(() => { setCareerSubView('career-dossier', 'assist'); });
    render(<CareerNavShell activeView="career-dossier" onOpen={vi.fn()} />);
    const subnav = screen.getByRole('navigation', { name: '我的求职' });
    expect(within(subnav).getByRole('button', { name: '助力记录' })).toHaveAttribute('aria-current', 'page');
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

  it('shows a collapsed L2 as a flyout while hovering the rail, and Esc closes it', () => {
    const onOpen = vi.fn();
    render(<CareerNavShell activeView="career-today" onOpen={onOpen} />);
    fireEvent.keyDown(window, { key: 'b', metaKey: true, ctrlKey: true });
    expect(document.querySelector('[data-career-subnav]')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /我的资料/ }));
    const flyout = document.querySelector('[data-career-subnav-flyout="assets"]') as HTMLElement;
    expect(flyout).not.toBeNull();
    fireEvent.click(within(flyout).getByRole('button', { name: '简历' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'career-material', view: 'resume' });
    expect(document.querySelector('[data-career-subnav-flyout]')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: /工作台/ }));
    expect(document.querySelector('[data-career-subnav-flyout="work"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-career-subnav-flyout]')).toBeNull();
  });
});
