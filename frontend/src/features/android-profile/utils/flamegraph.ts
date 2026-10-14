import { ApiError } from '../../../shared/api/index.ts';
import { decimalU64 } from '../../../shared/jobs/index.ts';
import { integer, PROFILE_LIMITS } from './rules.ts';
import type { StackFrame, StackSample } from '../types/index.ts';

export const PROFILE_FLAMEGRAPH_LIMITS = Object.freeze({ nodes: 200000, filters: 100000 });
export type ProfileFlameWeight = 'samples' | 'event_count';
export type ProfileFlameNodeKind = 'event' | 'process' | 'thread' | 'frame';
export interface ProfileFlameOptions {
  readonly weight?: ProfileFlameWeight;
  readonly processIds?: readonly (number | null)[];
  readonly threadIds?: readonly number[];
  readonly beginNs?: string;
  readonly endNs?: string;
}
export interface ProfileFlameQuality {
  readonly unwindingErrorSamples: number;
  readonly unwindingMetadataMissingSamples: number;
  readonly missingSymbolSamples: number;
}
export interface ProfileFlameNode {
  readonly id: number; readonly key: string; readonly kind: ProfileFlameNodeKind; readonly label: string;
  readonly frame: StackFrame | null; readonly eventType: string | null;
  readonly processId: number | null; readonly threadId: number | null;
  readonly weight: string; readonly selfWeight: string; readonly sampleCount: number;
  readonly quality: ProfileFlameQuality;
  readonly children: readonly ProfileFlameNode[];
}
export interface ProfileFlameLayoutNode extends ProfileFlameNode {
  readonly parentId: number | null; readonly depth: number;
  readonly startWeight: string; readonly endWeight: string;
}
export interface ProfileFlamegraph {
  readonly weight: ProfileFlameWeight; readonly clock: 'boottime';
  readonly totalWeight: string; readonly selectedSampleCount: number;
  readonly emptyCallchainSampleCount: number; readonly quality: ProfileFlameQuality;
  readonly roots: readonly ProfileFlameNode[]; readonly nodes: readonly ProfileFlameLayoutNode[];
}
interface MutableNode {
  id: number; readonly key: string; readonly kind: ProfileFlameNodeKind; readonly label: string;
  frame: StackFrame | null; readonly eventType: string | null;
  readonly processId: number | null; readonly threadId: number | null;
  weight: bigint; selfWeight: bigint; sampleCount: number; readonly quality: MutableQuality;
  readonly children: Map<string, MutableNode>;
}
interface MutableQuality { unwindingErrorSamples: number; unwindingMetadataMissingSamples: number; missingSymbolSamples: number }
interface Selection {
  readonly weight: ProfileFlameWeight; readonly processes: ReadonlySet<number | null> | null;
  readonly threads: ReadonlySet<number> | null; readonly begin: bigint | null; readonly end: bigint | null;
}
const newQuality = (): MutableQuality => ({ unwindingErrorSamples: 0, unwindingMetadataMissingSamples: 0, missingSymbolSamples: 0 });
function invalidFlamegraph(code = 'invalid_android_flamegraph_input'): ApiError {
  return new ApiError('protocol', code, 'Android 火焰图输入、筛选或资源范围无效');
}
function selection(options: ProfileFlameOptions): Selection {
  if (options.weight !== undefined && options.weight !== 'samples' && options.weight !== 'event_count'
    || options.beginNs !== undefined && !decimalU64(options.beginNs) || options.endNs !== undefined && !decimalU64(options.endNs)) throw invalidFlamegraph();
  const begin = options.beginNs === undefined ? null : BigInt(options.beginNs);
  const end = options.endNs === undefined ? null : BigInt(options.endNs);
  if (begin !== null && end !== null && begin > end) throw invalidFlamegraph();
  if (options.processIds !== undefined && (options.processIds.length > PROFILE_FLAMEGRAPH_LIMITS.filters
    || options.processIds.some(id => id !== null && !integer(id, 0, 4294967295)))
    || options.threadIds !== undefined && (options.threadIds.length > PROFILE_FLAMEGRAPH_LIMITS.filters
      || options.threadIds.some(id => !integer(id, 0, 4294967295)))) throw invalidFlamegraph();
  return { weight: options.weight ?? 'samples', begin, end,
    processes: options.processIds === undefined ? null : new Set(options.processIds),
    threads: options.threadIds === undefined ? null : new Set(options.threadIds) };
}
function addQuality(target: MutableQuality, value: ProfileFlameQuality): void {
  target.unwindingErrorSamples += value.unwindingErrorSamples;
  target.unwindingMetadataMissingSamples += value.unwindingMetadataMissingSamples;
  target.missingSymbolSamples += value.missingSymbolSamples;
}
function sampleQuality(sample: StackSample): ProfileFlameQuality {
  return { unwindingErrorSamples: sample.unwinding !== null
      && ((sample.unwinding.raw_error_code ?? 0) !== 0 || (sample.unwinding.error_code ?? 0) !== 0) ? 1 : 0,
    unwindingMetadataMissingSamples: sample.unwinding === null ? 1 : 0,
    missingSymbolSamples: sample.callchain.some(frame => frame.symbol === null || frame.symbol.length === 0) ? 1 : 0 };
}
// 聚合身份独立于展示标签；相同模块和执行类型的已知函数可合并地址，未知函数保留地址。
function frameIdentity(frame: StackFrame): { readonly key: string; readonly label: string } {
  const known = frame.symbol !== null && frame.symbol.length !== 0;
  const address = '0x' + BigInt(frame.address).toString(16);
  return { key: JSON.stringify([frame.file, frame.execution_type, known ? frame.symbol : null, known ? null : address]),
    label: known ? frame.symbol ?? '' : (frame.file === null || frame.file.length === 0 ? '未知模块' : frame.file) + ' @ ' + address };
}

interface NodeIdentity {
  readonly key: string; readonly kind: ProfileFlameNodeKind; readonly label: string;
  readonly frame: StackFrame | null; readonly eventType: string | null;
  readonly processId: number | null; readonly threadId: number | null;
}
function childNode(children: Map<string, MutableNode>, identity: NodeIdentity, allocated: { count: number }): MutableNode {
  const present = children.get(identity.key);
  if (present) {
    // 合并已知函数的多个地址时保留最小地址，避免输入样本顺序改变展示元数据。
    if (present.frame !== null && identity.frame !== null && BigInt(identity.frame.address) < BigInt(present.frame.address)) present.frame = identity.frame;
    return present;
  }
  if (allocated.count >= PROFILE_FLAMEGRAPH_LIMITS.nodes) throw invalidFlamegraph('android_flamegraph_node_limit');
  allocated.count += 1;
  const node: MutableNode = { ...identity, id: -1, weight: 0n, selfWeight: 0n, sampleCount: 0, quality: newQuality(), children: new Map() };
  children.set(identity.key, node); return node;
}
function addSample(node: MutableNode, weight: bigint, quality: ProfileFlameQuality): void {
  node.weight += weight; node.sampleCount += 1; addQuality(node.quality, quality);
}
function ordered(children: ReadonlyMap<string, MutableNode>): readonly MutableNode[] {
  return [...children.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
function freezeNodes(roots: ReadonlyMap<string, MutableNode>, signal?: AbortSignal): { readonly roots: readonly ProfileFlameNode[]; readonly nodes: readonly ProfileFlameLayoutNode[] } {
  const nodes: ProfileFlameLayoutNode[] = []; let nextId = 0;
  function convert(node: MutableNode, parentId: number | null, depth: number, start: bigint): ProfileFlameNode {
    if ((nextId & 255) === 0) signal?.throwIfAborted();
    const id = nextId; nextId += 1; node.id = id;
    const position = nodes.length;
    // 先保留父节点位置，子节点宽度从同一精确权重坐标开始；自权重留在末尾。
    const value: ProfileFlameNode = { id, key: node.key, kind: node.kind, label: node.label,
      frame: node.frame, eventType: node.eventType, processId: node.processId, threadId: node.threadId,
      weight: node.weight.toString(), selfWeight: node.selfWeight.toString(), sampleCount: node.sampleCount,
      quality: { ...node.quality }, children: [] };
    nodes.push({ ...value, parentId, depth, startWeight: start.toString(), endWeight: (start + node.weight).toString() });
    let cursor = start; const children: ProfileFlameNode[] = [];
    for (const child of ordered(node.children)) {
      children.push(convert(child, id, depth + 1, cursor)); cursor += child.weight;
    }
    const complete: ProfileFlameNode = { ...value, children };
    nodes[position] = { ...complete, parentId, depth, startWeight: start.toString(), endWeight: (start + node.weight).toString() };
    return complete;
  }
  let cursor = 0n; const result: ProfileFlameNode[] = [];
  for (const root of ordered(roots)) { result.push(convert(root, null, 0, cursor)); cursor += root.weight; }
  signal?.throwIfAborted(); return { roots: result, nodes };
}
// 输入为已解码的叶到根原栈；只计样本或原 event_count，不换算 CPU 耗时。
export function buildProfileFlamegraph(stacks: readonly StackSample[], options: ProfileFlameOptions = {}, signal?: AbortSignal): ProfileFlamegraph {
  signal?.throwIfAborted();
  if (stacks.length > PROFILE_LIMITS.stacks) throw invalidFlamegraph();
  const selected = selection(options); const roots = new Map<string, MutableNode>(); const allocated = { count: 0 };
  let totalWeight = 0n; let selectedSampleCount = 0; let emptyCallchainSampleCount = 0; const quality = newQuality();
  for (const [position, sample] of stacks.entries()) {
    if ((position & 255) === 0) signal?.throwIfAborted();
    if (!decimalU64(sample.time_ns) || !decimalU64(sample.event_count) || sample.callchain.length > PROFILE_LIMITS.chain) throw invalidFlamegraph();
    const time = BigInt(sample.time_ns);
    if (selected.processes !== null && !selected.processes.has(sample.process_id)
      || selected.threads !== null && !selected.threads.has(sample.thread_id)
      || selected.begin !== null && time < selected.begin || selected.end !== null && time >= selected.end) continue;
    const weight = selected.weight === 'samples' ? 1n : BigInt(sample.event_count); const flags = sampleQuality(sample);
    selectedSampleCount += 1; totalWeight += weight; addQuality(quality, flags);
    const event = childNode(roots, { key: JSON.stringify(['event', sample.event_type]), kind: 'event',
      label: sample.event_type === null || sample.event_type.length === 0 ? '未知事件' : sample.event_type,
      frame: null, eventType: sample.event_type, processId: null, threadId: null }, allocated);
    addSample(event, weight, flags);
    const process = childNode(event.children, { key: JSON.stringify(['process', sample.process_id]), kind: 'process',
      label: sample.process_id === null ? '未知进程' : '进程 ' + sample.process_id,
      frame: null, eventType: sample.event_type, processId: sample.process_id, threadId: null }, allocated);
    addSample(process, weight, flags);
    let node = childNode(process.children, { key: JSON.stringify(['thread', sample.thread_id]), kind: 'thread',
      label: '线程 ' + sample.thread_id, frame: null, eventType: sample.event_type,
      processId: sample.process_id, threadId: sample.thread_id }, allocated);
    addSample(node, weight, flags);
    if (sample.callchain.length === 0) emptyCallchainSampleCount += 1;
    for (let depth = sample.callchain.length - 1; depth >= 0; depth -= 1) {
      if ((depth & 63) === 0) signal?.throwIfAborted();
      const frame = sample.callchain[depth];
      if (!frame || !/^0x[0-9a-fA-F]{1,16}$/.test(frame.address)) throw invalidFlamegraph();
      const identity = frameIdentity(frame);
      node = childNode(node.children, { ...identity, kind: 'frame', frame: { ...frame, symbol: frame.symbol === '' ? null : frame.symbol, address: '0x' + BigInt(frame.address).toString(16) },
        eventType: sample.event_type, processId: sample.process_id, threadId: sample.thread_id }, allocated);
      addSample(node, weight, flags);
    }
    node.selfWeight += weight;
  }
  const frozen = freezeNodes(roots, signal);
  return { weight: selected.weight, clock: 'boottime', totalWeight: totalWeight.toString(), selectedSampleCount,
    emptyCallchainSampleCount, quality: { ...quality }, ...frozen };
}
