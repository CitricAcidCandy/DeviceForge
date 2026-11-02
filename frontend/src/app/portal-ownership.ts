import type { PortalReporter } from '../components/PortalBoundary/index.tsx';

interface Source {
  readonly root: HTMLElement;
  readonly anchor: HTMLElement;
  readonly pluginId: string;
  readonly generation: string;
  readonly panel: string | null;
  readonly extension: string | null;
}
interface Binding {
  readonly source: Source;
  readonly element: HTMLElement;
  readonly attributes: ReadonlyMap<string, { readonly previous: string | null; readonly value: string }>;
  readonly active: () => boolean;
  readonly release: () => void;
}
const owned = new WeakMap<Element, Binding>();
const managed = new WeakSet<Element>();
let sequence = 0;
const ownerSelector = '[data-deviceforge-plugin], [data-deviceforge-plugin-id]';
const portalAttribute = 'data-deviceforge-portal';

function sourceFor(root: HTMLElement): Source | null {
  const anchor = root.closest(ownerSelector);
  const view = root.ownerDocument.defaultView;
  if (!view || !(anchor instanceof view.HTMLElement) ||
      root.closest('[data-deviceforge-debugger-internal]')) return null;
  const pluginId = anchor.getAttribute('data-deviceforge-plugin') ?? anchor.getAttribute('data-deviceforge-plugin-id');
  const generation = anchor.getAttribute('data-deviceforge-generation');
  const panel = anchor.getAttribute('data-deviceforge-panel');
  const extension = anchor.getAttribute('data-deviceforge-extension');
  if (!pluginId || !generation || (!panel && !extension)) return null;
  return { root, anchor, pluginId, generation, panel, extension };
}

function current(source: Source, depth = 0): boolean {
  if (depth > 32 || !source.root.isConnected || !source.anchor.isConnected) return false;
  const now = sourceFor(source.root);
  if (!now || now.anchor !== source.anchor || now.pluginId !== source.pluginId ||
      now.generation !== source.generation || now.panel !== source.panel || now.extension !== source.extension)
    return false;
  if (!isManagedPortalRoot(source.anchor)) return true;
  const parent = owned.get(source.anchor);
  return !!parent && parent.active() && attributesCurrent(parent) && current(parent.source, depth + 1);
}
function attributesCurrent(binding: Binding): boolean {
  return [...binding.attributes].every(([name, attribute]) =>
    binding.element.getAttribute(name) === attribute.value);
}

/** 保留已登记节点的宿主身份，防止失效弹层被调试器降级成旧显式surface。 */
export function isManagedPortalRoot(element: Element): boolean {
  return managed.has(element) || element.hasAttribute(portalAttribute);
}

/** 只认可当前仍连接且原来源身份未变的宿主绑定，不通过DOM标记猜测归属。 */
export function resolveOwnedPortalRoot(element: Element): { readonly anchor: HTMLElement } | null {
  const binding = owned.get(element);
  if (!binding) return null;
  if (!binding.active() || !element.isConnected || !attributesCurrent(binding) || !current(binding.source)) {
    binding.release();
    return null;
  }
  return { anchor: binding.source.anchor };
}

/** 每个mountReact根独占一个同步可撤销作用域；不接管Portal位置或React卸载。 */
export function createPortalOwnership(root: HTMLElement): {
  readonly register: PortalReporter;
  readonly dispose: () => void;
} {
  const source = sourceFor(root);
  const bindings = new Set<Binding>();
  let closed = false;
  function report(element: HTMLElement): () => void {
    if (closed || !source || !current(source) || element === source.anchor ||
        element.ownerDocument !== root.ownerDocument) return () => {};
    const previousBinding = owned.get(element);
    if (previousBinding) {
      if (resolveOwnedPortalRoot(element)) return () => {};
      previousBinding.release();
    }
    const id = `${source.extension ?? source.panel}.portal.${++sequence}`;
    const added = new Map<string, { previous: string | null; value: string }>();
    const attributes: readonly (readonly [string, string])[] = [
      ['data-deviceforge-plugin', source.pluginId], ['data-deviceforge-generation', source.generation],
      ['data-deviceforge-extension', id], [portalAttribute, id],
    ];
    for (const [name, value] of attributes) {
      added.set(name, { previous: element.getAttribute(name), value });
      element.setAttribute(name, value);
    }
    let released = false;
    const binding: Binding = {
      source, element, attributes: added, active: () => !closed && !released,
      release() {
        if (released) return;
        released = true;
        bindings.delete(binding);
        if (owned.get(element) !== binding) return;
        owned.delete(element);
        for (const [name, attribute] of added) {
          if (element.getAttribute(name) !== attribute.value) continue;
          if (attribute.previous === null) element.removeAttribute(name);
          else element.setAttribute(name, attribute.previous);
        }
      },
    };
    bindings.add(binding);
    owned.set(element, binding);
    managed.add(element);
    return binding.release;
  }
  return {
    register: report,
    dispose() {
      if (closed) return;
      closed = true;
      for (const binding of [...bindings]) binding.release();
    },
  };
}
