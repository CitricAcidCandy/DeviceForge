
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { buildProfileFlamegraph } from '../../android-profile/index.ts';
import { ErrorNotice } from '@deviceforge/business-kit/react';
import type {
  ProfileFlamegraph,
  ProfileFlameOptions,
} from '../../android-profile/index.ts';
import { flameColor, flamePercent, layoutFlamegraph } from './layout.ts';
import type { StackSample } from '../../android-profile/index.ts';

export type { FlameInterval } from './interval.ts';
import type { FlameInterval } from './interval.ts';
export interface ProfileFlamegraphViewProps {
  readonly stacks: readonly StackSample[];
  readonly intervals?: readonly FlameInterval[];
}
interface GraphState {
  readonly graph: ProfileFlamegraph | null;
  readonly error: string | null;
}

export function ProfileFlamegraphView({ stacks, intervals = [] }: ProfileFlamegraphViewProps) {
  const id = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [weight, setWeight] = useState<'samples' | 'event_count'>('samples');
  const [process, setProcess] = useState('');
  const [thread, setThread] = useState('');
  const [begin, setBegin] = useState('');
  const [end, setEnd] = useState('');
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<{ graph: ProfileFlamegraph; id: number } | null>(null);
  const processes = useMemo(
    () =>
      [...new Set(stacks.map((sample) => sample.process_id))].sort((a, b) => (a ?? -1) - (b ?? -1)),
    [stacks],
  );
  const threads = useMemo(
    () =>
      [
        ...new Map(
          stacks
            .filter(
              (sample) =>
                process === '' ||
                (process === 'unknown'
                  ? sample.process_id === null
                  : sample.process_id === Number(process)),
            )
            .map((sample) => [sample.thread_id, sample.thread_name]),
        ).entries(),
      ].sort((a, b) => a[0] - b[0]),
    [stacks, process],
  );
  const state = useMemo<GraphState>(() => {
    try {
      const options: ProfileFlameOptions = {
        weight,
        ...(process === '' ? {} : { processIds: [process === 'unknown' ? null : Number(process)] }),
        ...(thread === '' ? {} : { threadIds: [Number(thread)] }),
        ...(begin === '' ? {} : { beginNs: begin }),
        ...(end === '' ? {} : { endNs: end }),
      };
      return { graph: buildProfileFlamegraph(stacks, options), error: null };
    } catch (error) {
      return { graph: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [stacks, weight, process, thread, begin, end]);
  const graph = state.graph;
  const focusId = focus?.graph === graph ? focus.id : null;
  const layout = useMemo(() => (graph ? layoutFlamegraph(graph, focusId) : null), [graph, focusId]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [graph, focusId]);
  const query = search.trim().toLocaleLowerCase();
  const matches =
    graph?.nodes.filter(
      (node) =>
        node.kind === 'frame' &&
        (node.label + ' ' + (node.frame?.file ?? '') + ' ' + (node.frame?.address ?? ''))
          .toLocaleLowerCase()
          .includes(query),
    ) ?? [];
  const matchWeight = matches.reduce((sum, node) => sum + BigInt(node.selfWeight), 0n).toString();
  const label = weight === 'samples' ? '样本数' : '事件计数';
  return (
    <section aria-label="调用栈火焰图" data-profile-flamegraph className="my-6">
      <h3 className="text-[15px] font-semibold">调用栈火焰图</h3>
      {state.error && <ErrorNotice error={new Error(`火焰图筛选条件无效：${state.error}`)} />}
      <p>宽度表示{label}；点击色块放大调用分支，键盘 Enter 或空格同样可操作。</p>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-weight'}>
          宽度权重
          <select
            id={id + '-weight'}
            value={weight}
            onChange={(event) =>
              setWeight(event.target.value === 'event_count' ? 'event_count' : 'samples')
            }
          >
            <option value="samples">样本数</option>
            <option value="event_count">事件计数（按事件分组）</option>
          </select>
        </label>
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-process'}>
          进程
          <select
            id={id + '-process'}
            value={process}
            onChange={(event) => {
              setProcess(event.target.value);
              setThread('');
            }}
          >
            <option value="">全部进程</option>
            {processes.map((pid) => (
              <option key={pid ?? 'unknown'} value={pid ?? 'unknown'}>
                {pid === null ? 'PID 未报告' : 'PID ' + pid}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-thread'}>
          线程
          <select
            id={id + '-thread'}
            value={thread}
            onChange={(event) => setThread(event.target.value)}
          >
            <option value="">全部线程</option>
            {threads.map(([tid, name]) => (
              <option key={tid} value={tid}>
                TID {tid} · {name ?? '未报告名称'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-begin'}>
          开始时间（boottime ns）
          <input
            id={id + '-begin'}
            inputMode="numeric"
            value={begin}
            onChange={(event) => setBegin(event.target.value)}
            placeholder="包含此时间"
          />
        </label>
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-end'}>
          结束时间（boottime ns）
          <input
            id={id + '-end'}
            inputMode="numeric"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            placeholder="不包含此时间"
          />
        </label>
        <label className="flex min-w-[130px] flex-[1_1_150px] flex-col gap-1" htmlFor={id + '-search'}>
          搜索函数、模块或地址
          <input
            id={id + '-search'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="my-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setBegin('');
            setEnd('');
            setProcess('');
            setThread('');
            setFocus(null);
          }}
        >
          全部样本
        </button>
        {intervals.map((interval, index) => (
          <button
            type="button"
            key={index}
            aria-pressed={begin === interval.beginNs && end === interval.endNs}
            onClick={() => {
              setBegin(interval.beginNs);
              setEnd(interval.endNs);
            }}
          >
            {interval.label}
          </button>
        ))}
        <button type="button" disabled={!layout?.focus} onClick={() => setFocus(null)}>
          重置缩放
        </button>
        <button
          type="button"
          disabled={!layout?.focus}
          onClick={() => {
            if (graph && layout?.focus?.parentId !== null && layout?.focus?.parentId !== undefined)
              setFocus({ graph, id: layout.focus.parentId });
            else setFocus(null);
          }}
        >
          上一级
        </button>
      </div>
      {graph && layout && (
        <>
          <p role="status" data-flame-summary>
            筛选 {graph.selectedSampleCount} 条样本 · 总{label} {graph.totalWeight} · 空调用链{' '}
            {graph.emptyCallchainSampleCount}
          </p>
          <p className="text-xs text-muted-foreground">
            展开错误 {graph.quality.unwindingErrorSamples} · 缺展开元数据{' '}
            {graph.quality.unwindingMetadataMissingSamples} · 含无符号帧{' '}
            {graph.quality.missingSymbolSamples}
            。缺符号显示模块与地址，展开失败只展示实际取得的部分调用链。
          </p>
          {query && (
            <p>
              匹配 {matches.length} 个函数节点；匹配节点自身权重 {matchWeight}
              （递归调用按节点计数）。
            </p>
          )}
          {layout.focus && (
            <p className="break-words">
              当前分支：{layout.focus.label}
              {layout.focus.frame &&
                ' · ' +
                  (layout.focus.frame.file ?? '未知模块') +
                  ' · ' +
                  layout.focus.frame.address}{' '}
              · {layout.focus.weight} {label} · 全图{' '}
              {flamePercent(layout.focus.weight, graph.totalWeight)}%
            </p>
          )}
          {BigInt(graph.totalWeight) === 0n ? (
            <p>此筛选范围没有有效权重；没有用相邻样本补齐。</p>
          ) : (
            <div
              ref={scroll}
              className="max-h-[620px] overflow-auto rounded-md border border-[#c8b9a5] bg-[#fffaf2]"
            >
              <svg
                role="group"
                aria-label="根在下方、叶在上方的调用栈火焰图"
                viewBox={'0 0 1000 ' + layout.levels * 26}
                width="100%"
                className="block min-w-[600px]"
              >
                {layout.bars.map(({ node, x, width, level }) => {
                  const y = (layout.levels - level - 1) * 26;
                  const hit =
                    !query ||
                    (
                      node.label +
                      ' ' +
                      (node.frame?.file ?? '') +
                      ' ' +
                      (node.frame?.address ?? '')
                    )
                      .toLocaleLowerCase()
                      .includes(query);
                  return (
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={node.label + '，' + node.weight + ' ' + label + '，放大分支'}
                      data-flame-node={node.id}
                      onClick={() => setFocus({ graph, id: node.id })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setFocus({ graph, id: node.id });
                        }
                      }}
                    >
                      <title>
                        {node.label +
                          (node.frame
                            ? '\n模块：' +
                              (node.frame.file ?? '未知模块') +
                              '，地址：' +
                              node.frame.address
                            : '') +
                          '\n累计：' +
                          node.weight +
                          '，自身：' +
                          node.selfWeight +
                          '\n样本：' +
                          node.sampleCount +
                          '，展开错误：' +
                          node.quality.unwindingErrorSamples}
                      </title>
                      <rect
                        x={x}
                        y={y}
                        width={Math.max(0.1, width - 0.3)}
                        height={24}
                        fill={flameColor(node)}
                        opacity={hit ? 1 : 0.28}
                        stroke={hit && query ? '#272727' : '#ffffff'}
                      />
                      {width > 35 && (
                        <text
                          x={x + 3}
                          y={y + 17}
                          fill="#242424"
                          fontSize={13}
                          className="pointer-events-none"
                        >
                          {node.label.slice(0, Math.max(1, Math.floor((width - 6) / 7)))}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          {layout.omitted > 0 && (
            <p className="text-xs text-muted-foreground">
              {layout.omitted} 个小节点未绘制；放大父分支可查看细节，聚合计数保留。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            这是采样分布，不是精确 CPU
            耗时。不同事件保持分组，事件计数跨事件不作耗时比较。时间筛选使用 [开始, 结束) 区间。
          </p>
        </>
      )}
    </section>
  );
}
