import type { DebugMetadata, DebugOwner } from '../../plugin-sdk/debug.ts';
import type { TreeAssertion, TreeAssertionResult, TreeCoverage, TreeDiff, TreeQuery, TreeQueryResult, TreeSnapshot, UiNode, UiNodeRef } from './contracts.ts';
import { accessibleName, actionPolicy, disabledState, hiddenState, opaqueElement, pluginBoundary, roleOf } from './dom-evidence.ts';
import { copyMetadata, copyOwner, freezeJson, jsonBytes, MAX_BYTES, MAX_NODES, MAX_SNAPSHOTS, text } from './json.ts';
import { measureLayout } from './layout.ts';
import { redactText, sensitiveControl } from './privacy.ts';
import { queryTree } from './query.ts';
import { assertTree } from './assert.ts';
import { diffTrees } from './diff.ts';

// 下列契约仅留在宿主本地，不能经 JSON bridge 传输 DOM 或回调。
export interface DebugSurface {
  readonly id: string;
  readonly kind: 'surface' | 'slot' | 'panel';
  readonly element: Element;
  readonly owner: DebugOwner;
}
export interface UiSemanticExtension {
  readonly role?: string;
  readonly name?: string;
  readonly generation?: string;
  readonly metadata?: DebugMetadata;
}
export interface UiCollectorOptions {
  readonly owner: DebugOwner;
  readonly surfaces?: readonly DebugSurface[];
  readonly hostOverview?: boolean;
  readonly semantic?: (element: Element) => UiSemanticExtension | undefined;
}
export interface UiCollector {
  readonly owner: DebugOwner;
  readonly root: Element;
  readonly snapshot: () => TreeSnapshot;
  readonly snapshots: () => readonly TreeSnapshot[];
  readonly page: (snapshotId: string, offset?: number, limit?: number) => TreeSnapshot | null;
  readonly pages: (snapshotId: string) => readonly TreeSnapshot[];
  readonly node: (reference: UiNodeRef) => UiNode | null;
  readonly query: (query: TreeQuery) => TreeQueryResult;
  readonly assert: (assertion: TreeAssertion) => TreeAssertionResult;
  readonly diff: (beforeId: string, afterId: string) => TreeDiff | null;
  readonly resolve: (reference: UiNodeRef) => Element | null;
  readonly reference: (element: Element) => UiNodeRef | null;
  readonly dispose: () => void;
}
interface Identity {
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly identity: string;
  readonly evidence: string;
}
let collectorSequence = 0;

export function createUiCollector(root: Element, options: UiCollectorOptions): UiCollector {
  const owner = copyOwner(options.owner);
  const namespace = `ui-${++collectorSequence}`;
  const surfaces = new Map<Element, DebugSurface>();
  for (const surface of options.surfaces ?? []) {
    text(surface.id, '宿主扩展点标识'); copyOwner(surface.owner);
    if (surface.element === root || root.contains(surface.element)) surfaces.set(surface.element, { ...surface, owner: copyOwner(surface.owner) });
  }
  let identities = new WeakMap<Element, Identity>();
  let currentElements = new Map<string, Element>();
  const history: TreeSnapshot[] = [];
  let serial = 0, revision = 0, snapshotSerial = 0, previousTree = '', disposed = false;
  const observer = root.ownerDocument.defaultView ? new root.ownerDocument.defaultView.MutationObserver((records) => retireRemoved(records)) : null;
  observer?.observe(root, { childList: true, subtree: true });
  if (root.parentNode) observer?.observe(root.parentNode, { childList: true });
  function retireRemoved(records: readonly MutationRecord[] = observer?.takeRecords() ?? []) {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        for (const element of currentElements.values()) {
          if (removed === element || removed.contains(element)) identities.delete(element);
        }
      }
    }
  }
  function belongs(element: Element): boolean {
    const boundary = pluginBoundary(element);
    const injected = surfaces.get(element)?.owner;
    return (boundary.pluginId === null || boundary.pluginId === owner.pluginId) &&
      (boundary.generation === null || boundary.generation === String(owner.generation)) &&
      (!injected || (injected.pluginId === owner.pluginId && injected.generation === owner.generation));
  }
  function rootCurrent(): boolean {
    let element: Element | null = root;
    while (element) {
      if (!belongs(element)) return false;
      if (pluginBoundary(element).pluginId !== null || surfaces.has(element)) break;
      element = element.parentElement;
    }
    return true;
  }
  function snapshot(): TreeSnapshot {
    if (disposed) throw new Error('DOM观测器已销毁');
    retireRemoved();
    const nodes: UiNode[] = [];
    const elements = new Map<string, Element>();
    const truncation = new Set<'nodes' | 'bytes' | 'scan'>();
    let visited = 0, excludedPluginRoots = 0, opaque = 0, estimatedBytes = 4096;
    const stack: { element: Element; parentId: string | null }[] = [{ element: root, parentId: null }];
    while (stack.length) {
      if (visited >= 5000) { truncation.add('scan'); break; }
      const entry = stack.pop();
      if (!entry) break;
      const { element, parentId } = entry;
      visited++;
      if (['script', 'style', 'template', 'noscript'].includes(element.localName) || element.hasAttribute('data-deviceforge-debugger-internal')) continue;
      const surface = surfaces.get(element);
      const foreign = !belongs(element) || (element === root && !rootCurrent());
      if (foreign) {
        excludedPluginRoots++;
        if (!options.hostOverview || !surface || element === root) continue;
      }
      const isOpaque = foreign || opaqueElement(element);
      const extension = !foreign && options.semantic ? options.semantic(element) : undefined;
      const role = extension?.role ? text(extension.role, '语义角色', 80) : roleOf(element);
      const name = redactText(foreign || sensitiveControl(element) ? '' : extension?.name !== undefined
        ? extension.name.slice(0, 256) : accessibleName(element, root, belongs));
      const metadata = copyMetadata(extension?.metadata);
      const identity = JSON.stringify([owner, role, element.localName, element.getAttribute('type'),
        element.getAttribute('data-deviceforge-generation'), extension?.generation ?? null, surface?.id ?? null]);
      const previous = identities.get(element);
      const hidden = hiddenState(element);
      const layout = measureLayout(element, root);
      const base = { owner: foreign && surface ? surface.owner : owner, parentId, role, name, tag: element.localName,
        kind: surface?.kind ?? 'dom', surfaceId: surface?.id ?? null,
        hidden, visible: hidden === 'yes' || layout.nonzeroSize === 'no' ? 'no' : 'unknown', layout, disabled: disabledState(element),
        required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true' ? 'yes' : 'no',
        invalid: element.getAttribute('aria-invalid') === 'true' ? 'yes' : element.getAttribute('aria-invalid') === 'false' ? 'no' : 'unknown',
        opaque: isOpaque,
        virtual: element.hasAttribute('data-deviceforge-virtual') ? 'declared' : 'unknown',
        confirmationRequired: element.closest('[data-deviceforge-confirm], [aria-haspopup="dialog"]') !== null,
        actionPolicy: foreign ? 'read-only' : actionPolicy(element), metadata } satisfies Omit<UiNode, keyof UiNodeRef>;
      // 区域和视口随其他区域变化，不能据此撤销本节点的局部引用。
      const { layout: measured, ...local } = base;
      const evidence = JSON.stringify({ ...local, rect: measured.rect });
      const state: Identity = {
        id: previous?.id ?? `${namespace}:${++serial}`,
        generation: previous ? previous.generation + Number(previous.identity !== identity) : 1,
        revision: previous ? previous.revision + Number(previous.evidence !== evidence || previous.identity !== identity) : 1,
        identity, evidence,
      };
      const node: UiNode = { ...base, id: state.id, generation: state.generation, revision: state.revision };
      const bytes = jsonBytes(node) + 1;
      if (estimatedBytes + bytes > MAX_BYTES) { truncation.add('bytes'); break; }
      estimatedBytes += bytes;
      identities.set(element, state); nodes.push(node); elements.set(state.id, element);
      if (isOpaque) { opaque++; continue; }
      // 输入和可编辑节点的内容不参与遍历；select 的选项只提供标签，不读取值或选择状态。
      if (['input', 'textarea'].includes(element.localName)) continue;
      const children = element.children;
      const remaining = 5000 - visited - stack.length;
      if (children.length > remaining) truncation.add('scan');
      for (let i = Math.min(children.length, remaining) - 1; i >= 0; i--) {
        const child = children.item(i);
        if (child) stack.push({ element: child, parentId: state.id });
      }
    }
    const coverage: TreeCoverage = { source: 'dom-accessible', completeness: 'observed-dom-only', visited,
      excludedPluginRoots, opaque, virtual: 'unknown', truncation: [...truncation] };
    const tree = JSON.stringify({ nodes, coverage });
    if (tree !== previousTree) { revision++; previousTree = tree; }
    const id = `${namespace}:snapshot:${++snapshotSerial}`;
    let result: TreeSnapshot = { id, owner, revision, observedAt: Date.now(), nodes, coverage, bytes: 0,
      page: { snapshotId: id, offset: 0, limit: MAX_NODES, nextOffset: null, total: nodes.length } };
    // bytes 字段自身也计入 UTF-8 响应大小。
    for (let i = 0; i < 4; i++) result = { ...result, bytes: jsonBytes(result) };
    const oldElements = currentElements;
    currentElements = elements;
    for (const element of oldElements.values()) if (!elements.has(identities.get(element)?.id ?? '')) identities.delete(element);
    const frozen = freezeJson(result);
    history.push(frozen);
    if (history.length > MAX_SNAPSHOTS) history.shift();
    return pageOf(frozen, 0, MAX_NODES);
  }
  function resolve(reference: UiNodeRef): Element | null {
    snapshot();
    const element = currentElements.get(reference.id);
    const node = element ? identities.get(element) : undefined;
    return node && element && node.generation === reference.generation && node.revision === reference.revision &&
      root.isConnected && element.isConnected && root.contains(element) ? element : null;
  }
  function pageOf(value: TreeSnapshot, offset: number, limit: number): TreeSnapshot {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.nodes.length || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NODES)
      throw new Error('快照页偏移或条数无效');
    const nodes = value.nodes.slice(offset, offset + limit);
    const end = offset + nodes.length;
    const truncation = new Set(value.coverage.truncation);
    if (offset > 0 || end < value.nodes.length) truncation.add('nodes');
    let result: TreeSnapshot = { ...value, nodes, coverage: { ...value.coverage, truncation: [...truncation] },
      page: { snapshotId: value.id, offset, limit, nextOffset: end < value.nodes.length ? end : null, total: value.nodes.length }, bytes: 0 };
    for (let index = 0; index < 4; index++) result = { ...result, bytes: jsonBytes(result) };
    return freezeJson(result);
  }
  return { owner, root, snapshot, snapshots: () => history.map((value) => pageOf(value, 0, MAX_NODES)), resolve,
    node(reference) {
      return history.at(-1)?.nodes.find((node) => node.id === reference.id && node.revision === reference.revision &&
        node.generation === reference.generation) ?? null;
    },
    query(query) {
      snapshot();
      const latest = history.at(-1);
      if (!latest) throw new Error('缺少当前树证据');
      return queryTree(latest, query);
    },
    assert(assertion) {
      snapshot();
      const latest = history.at(-1);
      if (!latest) throw new Error('缺少当前树证据');
      return assertTree(latest, assertion);
    },
    diff(beforeId, afterId) {
      const before = history.find((value) => value.id === beforeId), after = history.find((value) => value.id === afterId);
      return before && after ? diffTrees(before, after) : null;
    },
    page(snapshotId, offset = 0, limit = MAX_NODES) {
      const found = history.find((value) => value.id === snapshotId);
      return found ? pageOf(found, offset, limit) : null;
    },
    pages(snapshotId) {
      const found = history.find((value) => value.id === snapshotId);
      if (!found) return [];
      const pages: TreeSnapshot[] = [];
      for (let offset = 0; offset < Math.max(1, found.nodes.length); offset += MAX_NODES) pages.push(pageOf(found, offset, MAX_NODES));
      return pages;
    },
    reference(element) {
      if (disposed) return null;
      snapshot();
      const state = identities.get(element);
      return state && currentElements.get(state.id) === element
        ? { id: state.id, generation: state.generation, revision: state.revision } : null;
    },
    dispose() { disposed = true; observer?.disconnect(); history.length = 0; currentElements.clear(); identities = new WeakMap(); },
  };
}
