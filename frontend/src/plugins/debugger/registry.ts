import type {
  DebugAccess, DebugNodeDefinition, DebugNodeRecord, DebugOwner, DebugRegistrySnapshot,
  DebugResourceRecord, DebugEventRecord,
} from '../../plugin-sdk/debug.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import { copyMetadata, copyOwner, freezeJson, jsonBytes, MAX_BYTES, MAX_NODES, text } from './json.ts';
import { redactText } from './privacy.ts';
import { createDebugDataSources } from './data.ts';
import type { DebugDataSources } from './data.ts';

export type DebugTrack = (dispose: Dispose) => Dispose;
export interface DebugRegistry {
  readonly debug: DebugAccess;
  readonly data: DebugDataSources;
  readonly snapshot: () => DebugRegistrySnapshot;
  readonly dispose: () => Promise<void>;
}

export function createDebugRegistry(ownerInput: DebugOwner, signal: AbortSignal, track: DebugTrack): DebugRegistry {
  const owner = copyOwner(ownerInput);
  const nodes = new Map<string, DebugNodeRecord>();
  const resources = new Map<string, DebugResourceRecord>();
  const releases = new Set<() => Promise<void>>();
  const pending = new Set<Promise<void>>();
  const events: DebugEventRecord[] = [];
  const failures: unknown[] = [];
  let revision = 0, sequence = 0, generationSequence = 0, droppedEvents = 0, disposed = false;
  const data = createDebugDataSources(signal, () => { revision++; });
  function current() {
    if (disposed || signal.aborted) throw new Error('调试登记所属代际已撤销');
  }
  function definition(input: DebugNodeDefinition, generation: number, nodeRevision: number): DebugNodeRecord {
    text(input.id, '语义节点标识'); text(input.role, '语义角色'); text(input.label, '语义标签');
    if (input.parentId !== undefined) {
      if (!nodes.has(input.parentId) || input.parentId === input.id) throw new Error('语义父节点不存在或形成循环');
      let parent: string | null = input.parentId;
      while (parent) {
        if (parent === input.id) throw new Error('语义节点不能形成循环');
        parent = nodes.get(parent)?.parentId ?? null;
      }
    }
    return freezeJson({ id: input.id, generation, revision: nodeRevision, parentId: input.parentId ?? null,
      role: input.role, label: redactText(input.label), metadata: copyMetadata(input.metadata) });
  }
  const debug: DebugAccess = {
    registerDataSource: data.register,
    registerNode(input) {
      current();
      if (nodes.has(input.id)) throw new Error('语义节点标识已登记');
      if (nodes.size >= MAX_NODES) throw new Error('语义节点达到500项上限');
      const generation = ++generationSequence;
      nodes.set(input.id, definition(input, generation, 1)); revision++;
      let released = false;
      return Object.freeze({ id: input.id, generation,
        update(update: Omit<DebugNodeDefinition, 'id'>) {
          current();
          const previous = nodes.get(input.id);
          if (released || previous?.generation !== generation) throw new Error('语义节点旧代句柄已撤销');
          const candidate = definition({ ...update, id: input.id }, generation, previous.revision);
          if (JSON.stringify(candidate) !== JSON.stringify(previous)) {
            nodes.set(input.id, freezeJson({ ...candidate, revision: previous.revision + 1 })); revision++;
          }
        },
        dispose() {
          if (released) return;
          released = true;
          if (nodes.get(input.id)?.generation === generation) {
            nodes.delete(input.id);
            for (const [id, node] of nodes) if (node.parentId === input.id)
              nodes.set(id, freezeJson({ ...node, parentId: null, revision: node.revision + 1 }));
            revision++;
          }
        },
      });
    },
    emit(input) {
      current(); text(input.name, '事件名称');
      if (input.nodeId !== undefined && !nodes.has(input.nodeId)) throw new Error('事件所属语义节点不存在');
      events.push(freezeJson({ sequence: ++sequence, observedAt: Date.now(), name: redactText(input.name),
        nodeId: input.nodeId ?? null, metadata: copyMetadata(input.metadata) }));
      if (events.length > 500) { events.shift(); droppedEvents++; }
      revision++;
    },
    registerResource(input, release) {
      current(); text(input.id, '资源标识'); text(input.kind, '资源种类'); text(input.label, '资源标签');
      if (resources.has(input.id) || resources.size >= 500) throw new Error('资源标识重复或达到500项上限');
      const record: DebugResourceRecord = freezeJson({ id: input.id, generation: ++generationSequence,
        kind: input.kind, label: redactText(input.label), metadata: copyMetadata(input.metadata), state: 'registered' });
      resources.set(input.id, record); revision++;
      let task: Promise<void> | undefined;
      const run = (): Promise<void> => {
        if (task) return task;
        releases.delete(run);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = Promise.resolve().then(release);
        task = Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('调试资源释放超过1000毫秒，实际资源状态未知')), 1000);
        })]).then(() => {
          resources.set(input.id, freezeJson({ ...record, state: 'released' })); revision++;
        }, (error: unknown) => {
          resources.set(input.id, freezeJson({ ...record, state: 'release_failed' })); revision++;
          failures.push(error);
        }).finally(() => { if (timer) clearTimeout(timer); if (task) pending.delete(task); });
        pending.add(task);
        return task;
      };
      releases.add(run);
      return run;
    },
  };
  function close() {
    if (disposed) return;
    disposed = true; revision++; nodes.clear();
    data.dispose();
    signal.removeEventListener('abort', close);
    for (const release of [...releases].reverse()) void release();
  }
  async function dispose() {
    close();
    await Promise.all([...pending]);
    if (failures.length) throw new AggregateError([...failures], '调试资源释放存在失败或未知项');
  }
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  track(dispose);
  return {
    debug: Object.freeze(debug), data, dispose,
    snapshot() {
      const result = { owner, revision, disposed, nodes: [...nodes.values()], events: [...events],
        resources: [...resources.values()], droppedEvents, truncated: false };
      while (jsonBytes(result) > MAX_BYTES) {
        result.truncated = true;
        if (result.events.length) { result.events.shift(); result.droppedEvents++; }
        else if (result.resources.length) result.resources.pop();
        else result.nodes.pop();
      }
      return freezeJson(result);
    },
  };
}
