import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Puzzle, TriangleAlert } from 'lucide-react';
import type { ComponentInfo, Dispose, ExtensionCatalog } from '../../plugin-sdk/index.ts';
import type { ProductServices } from './services.ts';
import { pluginRoute } from './routes.ts';
import type { PluginRoute, ProductRoute } from './routes.ts';
import { pageSlotId, routeSlotId, slotModes } from './slots.ts';

const emptyCatalog: ExtensionCatalog = Object.freeze({
  components: Object.freeze([]),
  modules: Object.freeze([]),
  commands: Object.freeze([]),
  services: Object.freeze([]),
});
const ignoreKey = 'deviceforge.plugin-slot-ignored';

function readIgnoredSlot(slot: string): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(ignoreKey);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.some((entry) => entry === slot);
  } catch {
    return false;
  }
}
function writeIgnoredSlot(slot: string, ignored: boolean): void {
  try {
    const raw = globalThis.localStorage?.getItem(ignoreKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const current = Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    const next = ignored
      ? [...new Set([...current, slot])]
      : current.filter((entry) => entry !== slot);
    globalThis.localStorage?.setItem(ignoreKey, JSON.stringify(next));
  } catch {
    // 存储不可用时只在本次会话内生效，不影响接管本身。
  }
}
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '插件视图加载失败';
}

/** 目录订阅：注册表给的快照引用稳定，可直接作为 useSyncExternalStore 的数据源。 */
export function useExtensionCatalog(services: ProductServices): ExtensionCatalog {
  const source = services.runtime.extensions;
  const store = useMemo(
    () => ({
      get: () => {
        try {
          return source.catalog();
        } catch {
          return emptyCatalog;
        }
      },
      subscribe: (notify: () => void) => {
        try {
          return source.subscribe(notify);
        } catch {
          return () => undefined;
        }
      },
    }),
    [source],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** 槽位是否已被插件接管（replace）：给页签、导航与市场对账用。 */
export function useSlotOccupied(services: ProductServices, slot: string): boolean {
  const catalog = useExtensionCatalog(services);
  return catalog.components.some((entry) => entry.slot === slot && entry.mode === 'replace');
}

/** 已被插件整页替换的宿主路由：侧栏要标出来，用户得知道这页已经不是原生的。 */
export function useReplacedHostRoutes(services: ProductServices): ReadonlySet<string> {
  const catalog = useExtensionCatalog(services);
  return useMemo(
    () =>
      new Set(
        catalog.components
          .filter((entry) => entry.mode === 'replace' && entry.slot.startsWith('route.'))
          .map((entry) => entry.slot.slice('route.'.length)),
      ),
    [catalog],
  );
}

/** 仅追加槽位是否有插件内容：没有时整块不渲染，别在页面上留一张空卡。 */
export function useSlotAppends(services: ProductServices, slot: string): boolean {
  const catalog = useExtensionCatalog(services);
  return catalog.components.some((entry) => entry.slot === slot && entry.mode === 'append');
}

export interface PluginPageInfo {
  readonly key: PluginRoute;
  readonly title: string;
  readonly pluginId: string;
  readonly slot: string;
}
/** 插件声明的页面：一个 module 一条，直接可用作路由键与槽位标识。 */
export function usePluginPages(services: ProductServices): readonly PluginPageInfo[] {
  const catalog = useExtensionCatalog(services);
  return useMemo(
    () =>
      catalog.modules.map((entry) => ({
        key: pluginRoute(entry.pluginId, entry.route),
        title: entry.title,
        pluginId: entry.pluginId,
        slot: pageSlotId(entry.pluginId, entry.route),
      })),
    [catalog],
  );
}

function useIgnoredSlot(slot: string) {
  const [ignored, setIgnored] = useState(() => readIgnoredSlot(slot));
  useEffect(() => {
    setIgnored(readIgnoredSlot(slot));
  }, [slot]);
  const update = useCallback(
    (next: boolean) => {
      writeIgnoredSlot(slot, next);
      setIgnored(next);
    },
    [slot],
  );
  return [ignored, update] as const;
}

type MountKind = 'component' | 'module';
/** 一个槽位的接管者：路由级来自 component，插件页面来自 module。 */
interface SurfaceTarget {
  readonly id: string;
  readonly title: string;
  readonly pluginId: string;
  readonly kind: MountKind;
}
function targetOf(component: ComponentInfo): SurfaceTarget {
  return { id: component.id, title: component.title, pluginId: component.pluginId, kind: 'component' };
}
/** 先看有没有整块替换该槽位的组件，再看它是不是某个插件模块派生的页面槽位。 */
function replacementOf(catalog: ExtensionCatalog, slot: string): SurfaceTarget | null {
  const component = catalog.components.find(
    (entry) => entry.slot === slot && entry.mode === 'replace',
  );
  if (component) return targetOf(component);
  const page = catalog.modules.find((entry) => pageSlotId(entry.pluginId, entry.route) === slot);
  return page
    ? { id: page.id, title: page.title, pluginId: page.pluginId, kind: 'module' }
    : null;
}

interface SurfaceState {
  readonly replacement: SurfaceTarget | null;
  readonly appends: readonly ComponentInfo[];
  readonly active: SurfaceTarget | null;
  readonly ignored: boolean;
  readonly setIgnored: (next: boolean) => void;
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly failure: string | null;
  readonly mounted: boolean;
}

/**
 * 槽位生命周期：先晚注册槽位，再挂载替换贡献，卸载时先撤销贡献再释放槽位。
 * 顺序很重要——manager 按代次排队，先 unmount 才不会撞上「已挂载」的短路判断。
 */
function useSurface(services: ProductServices, slot: string): SurfaceState {
  const catalog = useExtensionCatalog(services);
  const host = services.runtime.extensions.slots;
  const replacement = replacementOf(catalog, slot);
  const appends = catalog.components.filter(
    (entry) => entry.slot === slot && entry.mode === 'append',
  );
  const [ignored, setIgnored] = useIgnoredSlot(slot);
  const active = ignored ? null : replacement;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [mountedId, setMountedId] = useState<string | null>(null);

  useEffect(() => {
    const target = hostRef.current;
    setFailure(null);
    setMountedId(null);
    setReady(false);
    if (!host || !target) return;
    let released: Dispose | null = null;
    let cancelled = false;
    void host
      .define({ id: slot, target, modes: slotModes(slot) })
      .then((dispose) => {
        if (cancelled) {
          void Promise.resolve(dispose()).catch(() => undefined);
          return;
        }
        released = dispose;
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(messageOf(error));
      });
    return () => {
      cancelled = true;
      setReady(false);
      const release = released;
      released = null;
      if (release) void Promise.resolve(release()).catch(() => undefined);
    };
  }, [host, slot]);

  const activeId = active?.id ?? null;
  const activeKind: MountKind | null = active?.kind ?? null;
  useEffect(() => {
    if (!host || !ready || !activeId || !activeKind) return;
    let cancelled = false;
    const extensions = services.runtime.extensions;
    const pending =
      activeKind === 'module'
        ? extensions.mountModule(activeId)
        : extensions.mountComponent(activeId);
    void pending
      .then(() => {
        if (!cancelled) setMountedId(activeId);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(messageOf(error));
      });
    return () => {
      cancelled = true;
      setMountedId(null);
      void extensions.unmount(activeId).catch(() => undefined);
    };
  }, [services, ready, activeId, activeKind]);

  const appendKey = appends.map((entry) => entry.id).join('|');
  useEffect(() => {
    if (!host || !ready || !appendKey) return;
    const ids = appendKey.split('|');
    let cancelled = false;
    for (const id of ids) {
      void services.runtime.extensions.mountComponent(id).catch((error: unknown) => {
        if (!cancelled) setFailure(messageOf(error));
      });
    }
    return () => {
      cancelled = true;
      for (const id of ids) void services.runtime.extensions.unmount(id).catch(() => undefined);
    };
  }, [services, ready, appendKey]);

  return {
    replacement,
    appends,
    active,
    ignored,
    setIgnored,
    hostRef,
    failure,
    mounted: activeId !== null && mountedId === activeId,
  };
}

function SourceBar({
  title,
  pluginId,
  onRestore,
}: {
  title: string;
  pluginId: string;
  onRestore: () => void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline bg-surface-elevated px-3 text-xs text-muted-foreground">
      <Puzzle className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="truncate">{title}</span>
      <span className="mono truncate text-faint">{pluginId}</span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/5"
        onClick={onRestore}
      >
        恢复默认
      </button>
    </div>
  );
}

function FailureBar({ message, onRestore }: { message: string; onRestore: () => void }) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/[0.07] px-3 py-1.5 text-xs text-muted-foreground"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">插件视图加载失败：{message}</span>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/5"
        onClick={onRestore}
      >
        恢复默认
      </button>
    </div>
  );
}

function IgnoredBar({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs text-muted-foreground">
      <span className="truncate">插件视图已关闭，当前显示宿主默认内容</span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/5"
        onClick={onEnable}
      >
        启用插件视图
      </button>
    </div>
  );
}

export interface ExtensionSurfaceProps {
  readonly services: ProductServices;
  readonly slot: string;
  readonly fallback: ReactNode;
  /** 整页槽位：接管后要撑满可用高度；区域槽位按内容自适应。 */
  readonly fill?: boolean;
}

/** 具名槽位的宿主挂载点：没有插件接管时原样渲染宿主内容。 */
export function ExtensionSurface({ services, slot, fallback, fill = false }: ExtensionSurfaceProps) {
  const state = useSurface(services, slot);
  const showsHost = state.active !== null || state.appends.length > 0;
  const wrapper = showsHost
    ? fill
      ? 'flex min-h-full w-full min-w-0 flex-col'
      : 'flex w-full min-w-0 flex-col'
    : 'contents';
  const target = showsHost
    ? state.active
      ? 'flex min-h-0 min-w-0 flex-1 flex-col'
      : 'flex min-w-0 flex-col'
    : 'hidden';
  return (
    <div className={wrapper} data-deviceforge-surface={slot}>
      {state.active && state.mounted && (
        <SourceBar
          title={state.active.title}
          pluginId={state.active.pluginId}
          onRestore={() => state.setIgnored(true)}
        />
      )}
      {state.failure && (
        <FailureBar message={state.failure} onRestore={() => state.setIgnored(true)} />
      )}
      {state.replacement && state.ignored && (
        <IgnoredBar onEnable={() => state.setIgnored(false)} />
      )}
      <div ref={state.hostRef} className={target} data-deviceforge-slot={slot} />
      {state.active ? null : fallback}
    </div>
  );
}

/** 路由级槽位：包住整页内容，插件可整页替换。 */
export function RouteSurface({
  services,
  route,
  children,
}: {
  services: ProductServices;
  route: ProductRoute;
  children: ReactNode;
}) {
  return (
    <ExtensionSurface services={services} slot={routeSlotId(route)} fallback={children} fill />
  );
}
