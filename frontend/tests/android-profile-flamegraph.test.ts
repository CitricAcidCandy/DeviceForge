import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfileFlamegraph, PROFILE_FLAMEGRAPH_LIMITS, PROFILE_LIMITS } from '../src/features/android-profile/index.ts';
import type { ProfileFlamegraph, ProfileFlameNode, StackFrame, StackSample } from '../src/features/android-profile/index.ts';
import { ApiError } from '../src/services/api/index.ts';

function frame(symbol: string | null, address = '0x1', file: string | null = 'libgame.so', execution_type: StackFrame['execution_type'] = 'native'): StackFrame {
  return { symbol, address, file, execution_type };
}
function sample(patch: Partial<StackSample> = {}): StackSample {
  return { time_ns: '100', thread_id: 43, process_id: 42, thread_name: '游戏主线程', event_type: 'cpu-clock', event_count: '1',
    callchain: [frame('leaf', '0x3'), frame('middle', '0x2'), frame('root', '0x1')],
    unwinding: { raw_error_code: 0, error_code: 0, error_address: null }, ...patch };
}
function chain(graph: ProfileFlamegraph): readonly ProfileFlameNode[] {
  const nodes: ProfileFlameNode[] = []; let current = graph.roots[0];
  while (current) { nodes.push(current); current = current.children[0]; }
  return nodes;
}
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_android_flamegraph_input';

test('火焰图将叶到根原栈转成事件、进程、线程和根到叶层次，合并重复路径', () => {
  const graph = buildProfileFlamegraph([sample(), sample()]);
  assert.deepEqual(chain(graph).map(node => node.kind), ['event', 'process', 'thread', 'frame', 'frame', 'frame']);
  assert.deepEqual(chain(graph).map(node => node.label), ['cpu-clock', '进程 42', '线程 43', 'root', 'middle', 'leaf']);
  assert.equal(graph.totalWeight, '2'); assert.equal(graph.selectedSampleCount, 2);
  assert.ok(chain(graph).every(node => node.weight === '2' && node.sampleCount === 2));
  assert.deepEqual(chain(graph).map(node => node.selfWeight), ['0', '0', '0', '0', '0', '2']);
  assert.equal(graph.clock, 'boottime'); assert.equal(graph.weight, 'samples');
});

test('同模块同执行类型的已知函数跨地址合并，重名模块和执行类型不混合', () => {
  const graph = buildProfileFlamegraph([
    sample({ callchain: [frame('update', '0x1', 'a.so')] }),
    sample({ callchain: [frame('update', '0x2', 'a.so')] }),
    sample({ callchain: [frame('update', '0x1', 'b.so')] }),
    sample({ callchain: [frame('update', '0x1', 'a.so', 'jit_jvm')] }),
  ]);
  const thread = chain(graph)[2]; assert.ok(thread);
  assert.equal(thread.children.length, 3);
  const native = thread.children.find(node => node.frame?.file === 'a.so' && node.frame.execution_type === 'native');
  assert.equal(native?.weight, '2'); assert.equal(native?.label, 'update');
});

test('缺符号按模块和规范化地址保留热点，不合并不同地址，不插假调用帧', () => {
  const graph = buildProfileFlamegraph([
    sample({ callchain: [frame(null, '0x000A', 'a.so')] }),
    sample({ callchain: [frame('', '0xa', 'a.so')] }),
    sample({ callchain: [frame(null, '0xb', 'a.so')] }),
    sample({ callchain: [frame(null, '0xa', null)] }),
  ]);
  const thread = chain(graph)[2]; assert.ok(thread);
  assert.equal(thread.children.length, 3);
  assert.equal(thread.children.find(node => node.label === 'a.so @ 0xa')?.weight, '2');
  assert.ok(thread.children.some(node => node.label === '未知模块 @ 0xa'));
  assert.equal(graph.nodes.filter(node => node.kind === 'frame').length, 3);
  assert.equal(graph.quality.missingSymbolSamples, 4);
});

test('BigInt精确累计原event_count且不同事件顶层分组，不将计数称为耗时', () => {
  const max = '18446744073709551615';
  const graph = buildProfileFlamegraph([sample({ event_count: max }), sample({ event_count: max }),
    sample({ event_type: 'instructions', event_count: '7' })], { weight: 'event_count' });
  assert.equal(graph.totalWeight, '36893488147419103237');
  assert.equal(graph.roots.length, 2); assert.equal(graph.weight, 'event_count');
  assert.equal(graph.roots.find(node => node.eventType === 'cpu-clock')?.weight, '36893488147419103230');
  assert.equal(graph.roots.find(node => node.eventType === 'instructions')?.weight, '7');
  assert.equal(graph.nodes.some(node => Object.hasOwn(node, 'duration')), false);
});

test('进程线程与半开boottime区间筛选精确到超安全整数纳秒，空筛选不补样本', () => {
  const begin = '90071992547409930'; const end = '90071992547409932';
  const stacks = [sample({ time_ns: '90071992547409929' }), sample({ time_ns: begin }),
    sample({ time_ns: '90071992547409931' }), sample({ time_ns: end }),
    sample({ time_ns: begin, process_id: 99 }), sample({ time_ns: begin, thread_id: 44 }),
    sample({ time_ns: begin, process_id: null })];
  assert.equal(buildProfileFlamegraph(stacks, { processIds: [42], threadIds: [43], beginNs: begin, endNs: end }).totalWeight, '2');
  assert.equal(buildProfileFlamegraph(stacks, { processIds: [null], beginNs: begin, endNs: end }).totalWeight, '1');
  const empty = buildProfileFlamegraph(stacks, { processIds: [] });
  assert.equal(empty.totalWeight, '0'); assert.equal(empty.selectedSampleCount, 0); assert.deepEqual(empty.roots, []); assert.deepEqual(empty.nodes, []);
  assert.equal(buildProfileFlamegraph(stacks, { beginNs: begin, endNs: begin }).selectedSampleCount, 0);
});

test('展开错误与缺展开元数据独立保留，空栈计入线程自权重而不制造函数', () => {
  const graph = buildProfileFlamegraph([
    sample({ unwinding: { raw_error_code: 7, error_code: null, error_address: '0x2' }, callchain: [frame(null)] }),
    sample({ unwinding: null, callchain: [] }),
    sample(),
  ]);
  assert.deepEqual(graph.quality, { unwindingErrorSamples: 1, unwindingMetadataMissingSamples: 1, missingSymbolSamples: 1 });
  assert.equal(graph.emptyCallchainSampleCount, 1);
  const thread = chain(graph)[2]; assert.ok(thread);
  assert.equal(thread.selfWeight, '1'); assert.equal(thread.weight, '3');
  assert.deepEqual(thread.quality, graph.quality);
  assert.ok(graph.nodes.every(node => !node.label.includes('展开成功')));
});

test('递归函数保留不同栈深，父子精确区间不重叠且自权重可留白', () => {
  const graph = buildProfileFlamegraph([
    sample({ callchain: [frame('recurse'), frame('recurse'), frame('root')] }),
    sample({ callchain: [frame('root')] }),
    sample({ callchain: [] }),
    sample({ event_type: 'instructions', callchain: [frame(null)] }),
  ]);
  const recursive = graph.nodes.filter(node => node.label === 'recurse');
  assert.equal(recursive.length, 2); assert.notEqual(recursive[0]?.depth, recursive[1]?.depth);
  for (const node of graph.nodes) {
    assert.equal(BigInt(node.endWeight) - BigInt(node.startWeight), BigInt(node.weight));
    const children = graph.nodes.filter(child => child.parentId === node.id);
    assert.equal(children.reduce((sum, child) => sum + BigInt(child.weight), BigInt(node.selfWeight)), BigInt(node.weight));
    let cursor = BigInt(node.startWeight);
    for (const child of children) { assert.equal(BigInt(child.startWeight), cursor); cursor = BigInt(child.endWeight); }
    assert.ok(cursor <= BigInt(node.endWeight));
  }
  assert.equal(graph.roots.reduce((sum, root) => sum + BigInt(root.weight), 0n).toString(), graph.totalWeight);
});

test('零event_count与未知事件仍保留样本和质量，缺过滤结果为真正空树', () => {
  const graph = buildProfileFlamegraph([sample({ event_type: null, process_id: null, event_count: '0', unwinding: null })], { weight: 'event_count' });
  assert.equal(graph.totalWeight, '0'); assert.equal(graph.selectedSampleCount, 1);
  assert.equal(graph.roots[0]?.label, '未知事件'); assert.equal(graph.roots[0]?.children[0]?.label, '未知进程');
  assert.equal(graph.quality.unwindingMetadataMissingSamples, 1);
  assert.ok(graph.nodes.every(node => node.startWeight === '0' && node.endWeight === '0'));
  assert.deepEqual(buildProfileFlamegraph([]).nodes, []);
});

test('筛选区间、u64、输入链和资源范围拒绝无效值，提前取消不交付部分模型', () => {
  for (const options of [{ beginNs: '020' }, { beginNs: '30', endNs: '20' }, { endNs: '-1' },
    { endNs: '18446744073709551616' }, { threadIds: [-1] }, { processIds: [4294967296] }]) {
    assert.throws(() => buildProfileFlamegraph([sample()], options), invalid);
  }
  assert.throws(() => buildProfileFlamegraph([sample({ event_count: '01' })]), invalid);
  assert.throws(() => buildProfileFlamegraph([sample({ callchain: Array.from({ length: PROFILE_LIMITS.chain + 1 }, () => frame('deep')) })]), invalid);
  assert.throws(() => buildProfileFlamegraph(Array<StackSample>(PROFILE_LIMITS.stacks + 1)), invalid);
  assert.throws(() => buildProfileFlamegraph([], { threadIds: Array<number>(PROFILE_FLAMEGRAPH_LIMITS.filters + 1).fill(0) }), invalid);
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => buildProfileFlamegraph([sample()], {}, aborted.signal), { name: 'AbortError' });
});

test('同一聚合样本不同输入顺序产生相同树序与节点ID，不修改原栈顺序', () => {
  const one = sample({ callchain: [frame('leaf-b'), frame('root')] });
  const two = sample({ callchain: [frame('leaf-a'), frame('root')] });
  const otherAddress = sample({ callchain: [frame('leaf-b', '0x10'), frame('root', '0x20')] });
  const stacks = [one, two, otherAddress]; const original = structuredClone(stacks);
  assert.deepEqual(buildProfileFlamegraph(stacks), buildProfileFlamegraph([otherAddress, two, one]));
  assert.deepEqual(stacks, original);
});
