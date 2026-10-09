/**
 * App Shell navigation: L1 rail (areas) + L2 sub-nav (work pages).
 * Layout and states follow specs/CAREER_DESIGN.md §5.
 */
import {
  Award,
  Bell,
  Cat,
  Globe,
  Info,
  Keyboard,
  LifeBuoy,
  SlidersHorizontal,
  Wrench,
  Briefcase,
  FileText,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Quote,
  Send,
  Settings,
  Star,
  Sun,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  AREA_DIRECT_TARGET,
  NAV_AREAS,
  areaDefinition,
  locateNav,
  type NavArea,
  type NavIconName,
  type NavItem,
  type NavTarget,
} from './navModel';
import { useCareerSubViews } from './subViewStore';

const ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  chat: MessagesSquare,
  briefcase: Briefcase,
  grid: LayoutGrid,
  folder: FolderOpen,
  settings: Settings,
  sun: Sun,
  list: ListChecks,
  inbox: Inbox,
  star: Star,
  send: Send,
  pencil: PenLine,
  users: Users,
  user: User,
  file: FileText,
  quote: Quote,
  award: Award,
  sliders: SlidersHorizontal,
  pet: Cat,
  globe: Globe,
  keyboard: Keyboard,
  wrench: Wrench,
  bell: Bell,
  help: LifeBuoy,
  info: Info,
};

const COLLAPSE_KEY = 'career:subnav-collapsed';
/** Below this width L2 always collapses into a flyout (specs/CAREER_DESIGN.md §5.6). */
const NARROW_QUERY = '(max-width: 1279px)';
const FLYOUT_CLOSE_DELAY_MS = 300;

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}
const LAST_ITEM_KEY = 'career:subnav-last-item';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or disabled storage only loses the remembered preference.
  }
}

export interface CareerNavShellProps {
  /** `view` of the active tab; drives both levels' selected state. */
  activeView: string | undefined;
  /** Opens a target; the App owns tabs and sub-view selection. */
  onOpen: (target: NavTarget) => void;
}

export function CareerNavShell({ activeView, onOpen }: CareerNavShellProps) {
  const subViews = useCareerSubViews();
  const located = useMemo(() => locateNav(activeView, subViews), [activeView, subViews]);
  // The area shown in L2 follows the active tab, but an area clicked in L1 shows
  // immediately even before its page finishes opening.
  // Keyed by the navigation state at click time, so it lapses on its own once
  // the active tab or sub-view changes.
  const navKey = `${activeView ?? ''}|${JSON.stringify(subViews)}`;
  const [pending, setPending] = useState<{ area: NavArea; navKey: string } | null>(null);
  const area = pending && pending.navKey === navKey ? pending.area : located.area;
  const setPendingArea = (next: NavArea) => setPending({ area: next, navKey });

  const [collapsed, setCollapsed] = useState(() => readJson(COLLAPSE_KEY, false));
  const toggleCollapsed = useCallback(() => {
    setCollapsed((value: boolean) => {
      writeJson(COLLAPSE_KEY, !value);
      return !value;
    });
  }, []);

  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const effectiveCollapsed = collapsed || narrow;

  // Collapsed L2 reappears as a flyout over the content while the pointer or
  // focus is on the rail; it never pushes the layout.
  const [flyoutArea, setFlyoutArea] = useState<NavArea | null>(null);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setFlyoutArea(null), FLYOUT_CLOSE_DELAY_MS);
  };
  useEffect(() => () => cancelClose(), []);
  const peekArea = (next: NavArea) => {
    if (!effectiveCollapsed) return;
    cancelClose();
    setFlyoutArea(areaDefinition(next).items.length > 0 ? next : null);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFlyoutArea(null);
        return;
      }
      const mod = navigator.platform.toLowerCase().includes('mac') ? event.metaKey : event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [toggleCollapsed]);

  // Remember the last L2 item per area so returning to an area restores it.
  useEffect(() => {
    if (!located.area || !located.itemId) return;
    const last = readJson<Record<string, string>>(LAST_ITEM_KEY, {});
    if (last[located.area] === located.itemId) return;
    writeJson(LAST_ITEM_KEY, { ...last, [located.area]: located.itemId });
  }, [located.area, located.itemId]);

  const openArea = (next: NavArea) => {
    const direct = AREA_DIRECT_TARGET[next];
    if (direct) {
      setPendingArea(next);
      onOpen(direct);
      return;
    }
    const definition = areaDefinition(next);
    const lastId = readJson<Record<string, string>>(LAST_ITEM_KEY, {})[next];
    const item = definition.items.find(candidate => candidate.id === lastId) ?? definition.items[0];
    setPendingArea(next);
    onOpen(item.target);
  };

  const definition = area ? areaDefinition(area) : null;
  const showSubNav = Boolean(definition && definition.items.length > 0) && !effectiveCollapsed;
  const flyoutDefinition = effectiveCollapsed && flyoutArea ? areaDefinition(flyoutArea) : null;
  const selectItem = (item: NavItem) => {
    setFlyoutArea(null);
    onOpen(item.target);
  };

  return (
    <>
      <nav
        className="flex h-full w-[var(--nav-rail-width)] shrink-0 flex-col items-center border-r border-[var(--line)] bg-[var(--rail)] pb-3"
        aria-label="主导航"
        data-career-rail
        onMouseLeave={flyoutDefinition ? scheduleClose : undefined}
      >
        {/* Drag strip; on macOS the native traffic lights sit here. */}
        <div className="custom-titlebar h-11 w-full shrink-0" data-tauri-drag-region />
        <div
          className="mb-4 grid h-[34px] w-[34px] place-items-center rounded-[7px] bg-[var(--seal)] font-human text-lg font-semibold text-white shadow-[inset_0_0_0_2px_var(--bg),0_0_0_1.5px_var(--seal)]"
          aria-hidden="true"
        >
          职
        </div>
        <RailGroup areas={NAV_AREAS.filter(item => !item.footer)} active={area} onSelect={openArea} onPeek={peekArea} />
        <div className="flex-1" />
        <RailGroup areas={NAV_AREAS.filter(item => item.footer)} active={area} onSelect={openArea} onPeek={peekArea} />
      </nav>

      {showSubNav && definition && (
        <nav
          className="flex h-full w-[var(--nav-sub-width)] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--side)] px-2.5"
          aria-label={definition.label}
          data-career-subnav={definition.id}
        >
          <div className="custom-titlebar flex h-11 shrink-0 items-center justify-end" data-tauri-drag-region>
            <CollapseButton collapsed={false} onToggle={toggleCollapsed} />
          </div>
          <SubNavList
            items={definition.items}
            activeId={area === located.area ? located.itemId : null}
            onSelect={selectItem}
          />
        </nav>
      )}

      {flyoutDefinition && (
        <nav
          className="absolute bottom-0 left-[var(--nav-rail-width)] top-0 z-30 flex w-[var(--nav-sub-width)] flex-col border-r border-[var(--line)] bg-[var(--side)] px-2.5 shadow-lg"
          aria-label={flyoutDefinition.label}
          data-career-subnav-flyout={flyoutDefinition.id}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="h-11 shrink-0" />
          <SubNavList
            items={flyoutDefinition.items}
            activeId={flyoutDefinition.id === located.area ? located.itemId : null}
            onSelect={selectItem}
          />
        </nav>
      )}

      {collapsed && !narrow && definition && definition.items.length > 0 && !flyoutDefinition && (
        <div className="absolute left-[calc(var(--nav-rail-width)+4px)] top-1.5 z-30" data-no-drag>
          <CollapseButton collapsed onToggle={toggleCollapsed} />
        </div>
      )}
    </>
  );
}

function RailGroup({ areas, active, onSelect, onPeek }: {
  areas: readonly (typeof NAV_AREAS)[number][];
  active: NavArea | null;
  onSelect: (area: NavArea) => void;
  onPeek: (area: NavArea) => void;
}) {
  return (
    <ul className="flex flex-col items-center gap-1.5">
      {areas.map(definition => {
        const Icon = ICONS[definition.icon];
        const selected = definition.id === active;
        return (
          <li key={definition.id}>
            <button
              type="button"
              onClick={() => onSelect(definition.id)}
              onMouseEnter={() => onPeek(definition.id)}
              onFocus={() => onPeek(definition.id)}
              aria-current={selected ? 'page' : undefined}
              className={`flex min-h-[58px] w-[62px] flex-col items-center justify-center gap-1 rounded-[10px] font-human text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${
                selected
                  ? 'bg-[var(--paper)] text-[var(--ink)] shadow-[0_0_0_1px_var(--line),0_1px_0_var(--line-2)]'
                  : 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]'
              }`}
              data-career-rail-item={definition.id}
            >
              <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              <span>{definition.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SubNavList({ items, activeId, onSelect }: {
  items: readonly NavItem[];
  activeId: string | null;
  onSelect: (item: NavItem) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5 pt-1">
      {items.map(item => (
        <SubNavItem key={item.id} item={item} active={item.id === activeId} onSelect={() => onSelect(item)} />
      ))}
    </ul>
  );
}

function SubNavItem({ item, active, onSelect }: { item: NavItem; active: boolean; onSelect: () => void }) {
  const Icon = ICONS[item.icon];
  return (
    <li className="relative">
      {active && (
        <span
          className="absolute -left-1 top-1.5 h-6 w-2 rounded-[1px] bg-[var(--primary)] opacity-75"
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left font-human text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${
          active
            ? 'bg-[var(--paper)] text-[var(--ink)] shadow-[0_0_0_1px_var(--line)]'
            : 'text-[var(--ink-2)] hover:bg-[var(--hover)]'
        }`}
        data-career-subnav-item={item.id}
      >
        <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`} strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{item.label}</span>
      </button>
    </li>
  );
}

function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? '展开二级导航（⌘B）' : '收起二级导航（⌘B）';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      data-no-drag
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
