import * as React from 'react';
import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { array, object, parseJson, text } from './protocol.ts';
import type { UiNode } from './protocol.ts';
import { filterNodes, nodeDepth } from './tree-utils.ts';
import { Badge, Button, Check, Definition, Empty, fieldClass, JsonDetails, ResultView } from './ui.tsx';

interface IndentStyle extends React.CSSProperties { '--df-depth': string }
const evidence = (value: unknown) => value === 'yes' ? '是' : value === 'no' ? '否' : '未知';
export function TreeView({ state, controller }: { state: DebuggerState; controller: DebuggerController }) {
  const [name, setName] = React.useState(''), [role, setRole] = React.useState('');
  const [hidden, setHidden] = React.useState(''), [disabled, setDisabled] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = React.useState(false), [allowUnknown, setAllowUnknown] = React.useState(false);
  const [value, setValue] = React.useState(''), [action, setAction] = React.useState('click');
  const [assertion, setAssertion] = React.useState('{"query":{"role":"button"},"condition":"exists"}');
  const [before, setBefore] = React.useState(''), [after, setAfter] = React.useState(''), [inputError, setInputError] = React.useState('');
  const nodes = state.tree?.nodes ?? [];
  const visible = filterNodes(nodes, { name, role, hidden, disabled }, collapsed, state.queries);
  const selected = nodes.find((node) => node.id === state.selectedNodeId);
  const unavailable = state.stale || !state.connected || !state.sessionId || Boolean(state.busy);
  const supported = object(object(state.inspection).capabilities);
  React.useEffect(() => { setConfirmed(false); setAllowUnknown(false); setValue(''); }, [state.selectedNodeId, state.rootId, state.sessionId]);
  function toggle(node: UiNode) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; });
  }
  function parseWork(source: string, work: (value: JsonValue) => Promise<void>) {
    try { const data = parseJson(source); setInputError(''); void work(data); }
    catch (error) { setInputError(error instanceof Error ? error.message : 'JSON 无效'); }
  }
  const page = object(object(state.tree?.raw).page), coverage = object(object(state.tree?.raw).coverage);
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 items-center gap-2 text-[13px]">挂载根<select aria-label="挂载根" className={fieldClass} value={state.rootId}
        disabled={state.stale || Boolean(state.busy)} onChange={(event) => controller.setRoot(event.currentTarget.value)}>
        <option value="">{state.roots.length > 1 ? '请明确选择挂载根' : '暂无挂载根'}</option>
        {state.roots.map((root) => <option key={root.id} value={root.id}>{root.label || root.id} · {root.id}</option>)}
      </select></label>
      <Button disabled={unavailable || (state.roots.length > 1 && !state.rootId)} onClick={() => void controller.tree()}>读取新快照</Button>
      <Button disabled={unavailable || supported.pick === false} title={supported.pick === false ? '宿主未提供公开拾取能力' : '点击插件节点；Esc 取消'}
        onClick={() => void controller.action('pick', null, '', false, false)}>拾取节点</Button>
      <Button disabled={unavailable} onClick={() => void controller.overview()}>公开槽位与路由</Button>
      {state.tree && <Badge warning={state.stale}>{state.stale ? '已过期 · 只读' : '只读观测快照'}</Badge>}
    </div>
    <p className="rounded-md bg-[#F7F8FC] px-3 py-2 text-[13px] text-[#556176]">可观测节点不等于公开插入槽位。隐藏、遮挡和虚拟内容可能未知；不完整采集不能证明节点不存在。</p>
    {state.target?.kind === 'server' ? <Empty title="服务器目标不提供浏览器 UI 树">可以检查公开服务、查询事件和服务器日志，试调用仍沿原任务执行。</Empty>
      : !state.tree ? <Empty title={state.roots.length ? '尚未读取此挂载根的快照' : '目标未提供已实例化的挂载根'}>
        {state.roots.length > 1 ? '选择一个挂载根，再读取结构树。' : '未打开页面不会生成 UI 树。可以查询公开目录或在原业务入口打开页面后刷新检查。'}
      </Empty> : <div className="grid min-h-64 flex-1 grid-cols-[minmax(190px,28%)_minmax(0,1fr)] gap-4 max-[700px]:grid-cols-1">
        <section aria-label="UI 结构树" className="flex min-h-0 flex-col rounded-lg border border-[#E6EAF3]">
          <div className="space-y-2 border-b border-[#E6EAF3] p-3">
            <input className={`${fieldClass} w-full`} placeholder="搜索名称或节点 ID" aria-label="搜索节点" value={name} onChange={(event) => setName(event.currentTarget.value)} />
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="语义角色" className={fieldClass} value={role} onChange={(event) => setRole(event.currentTarget.value)}><option value="">全部角色</option>
                {[...new Set(nodes.map((node) => node.role))].filter(Boolean).map((item) => <option key={item}>{item}</option>)}
              </select>
              <select aria-label="隐藏状态" className={fieldClass} value={hidden} onChange={(event) => setHidden(event.currentTarget.value)}><option value="">全部隐藏状态</option><option value="yes">已隐藏</option><option value="no">未隐藏</option><option value="unknown">隐藏未知</option></select>
            </div>
            <select aria-label="禁用状态" className={`${fieldClass} w-full`} value={disabled} onChange={(event) => setDisabled(event.currentTarget.value)}><option value="">全部禁用状态</option><option value="yes">已禁用</option><option value="no">未禁用</option><option value="unknown">禁用未知</option></select>
            <div className="flex flex-wrap gap-2"><Button disabled={unavailable} onClick={() => void controller.query({ ...(name ? { name } : {}), ...(role ? { role } : {}),
              ...(hidden ? { hidden } : {}), ...(disabled ? { disabled } : {}), limit: 500 })}>按语义查询</Button>
              {state.queries && <Button onClick={() => controller.clearQuery()}>清除查询</Button>}</div>
          </div>
          <ul role="tree" aria-label="已观测节点" className="min-h-0 flex-1 overflow-auto p-2">
            {visible.map((node, index) => {
              const hasChildren = nodes.some((child) => child.parentId === node.id);
              const indent: IndentStyle = { '--df-depth': `${8 + nodeDepth(node, nodes) * 14}px` };
              return <li role="none" key={node.id} className="flex items-center">
                {hasChildren && <button type="button" aria-label={`${collapsed.has(node.id) ? '展开' : '折叠'} ${node.name || node.role}`} className="size-6 shrink-0 rounded text-[#556176] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]" onClick={() => toggle(node)}>{collapsed.has(node.id) ? '▸' : '▾'}</button>}
                <button type="button" role="treeitem" aria-selected={node.id === state.selectedNodeId} aria-level={nodeDepth(node, nodes) + 1}
                  aria-expanded={hasChildren ? !collapsed.has(node.id) : undefined} style={indent}
                  className={`${node.id === state.selectedNodeId ? 'bg-[#EFEBFF] text-[#6C4CF5]' : 'text-[#23272E] hover:bg-[#F7F8FC]'} min-h-9 min-w-0 flex-1 rounded py-2 pr-2 pl-[var(--df-depth)] text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`}
                  title={`${node.role} · ${node.name}\n${node.id}`} onClick={() => controller.setNode(node.id)} onKeyDown={(event) => {
                    const offset = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                    const next = visible[index + offset];
                    if (offset && next) { event.preventDefault(); controller.setNode(next.id);
                      const items = event.currentTarget.closest('[role=tree]')?.querySelectorAll<HTMLElement>('[role=treeitem]'); items?.[index + offset]?.focus(); }
                    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && hasChildren) { event.preventDefault();
                      setCollapsed((current) => { const nextSet = new Set(current); if (event.key === 'ArrowLeft') nextSet.add(node.id); else nextSet.delete(node.id); return nextSet; }); }
                  }}><span className="block truncate font-medium">{node.name || node.role || node.raw.tag?.toString() || '未命名节点'}</span>
                  <span className="block truncate text-xs text-[#556176]">{node.role} · {node.id}</span></button>
              </li>;
            })}
            {!visible.length && <li className="p-3 text-[13px] text-[#556176]">当前页没有匹配节点。</li>}
          </ul>
          <div className="border-t border-[#E6EAF3] p-2 text-xs text-[#556176]">已加载 {nodes.length} / {typeof page.total === 'number' ? page.total : nodes.length} 节点
            {typeof page.nextOffset === 'number' && <Button disabled={unavailable} onClick={() => void controller.nextTreePage()}>加载下一页</Button>}</div>
        </section>
        <section aria-label="节点详情" className="min-h-0 space-y-3 overflow-auto rounded-lg border border-[#E6EAF3] p-4">
          {!selected ? object(state.result).source === 'host-dom' ? <ResultView value={state.result} /> : <Empty title="选择左侧节点查看详情">节点标识与修订绑定当前快照；读取新快照后动作仍由宿主核验。</Empty> : <>
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-[15px] font-semibold">{selected.name || selected.role}</h3><Badge>{text(selected.raw.kind, '节点')}</Badge>{state.stale && <Badge warning>当时观测 · 已过期</Badge>}</div>
            <dl><Definition label="节点 ID"><code>{selected.id}</code></Definition><Definition label="节点引用"><code>g{selected.generation} / r{selected.revision}</code></Definition>
              <Definition label="所属表面"><code>{text(selected.raw.surfaceId, '未提供')}</code></Definition><Definition label="语义角色">{selected.role || '未提供'}</Definition>
              <Definition label="状态证据">隐藏 {evidence(selected.raw.hidden)} · 禁用 {evidence(selected.raw.disabled)} · 可见 {evidence(selected.raw.visible)}</Definition>
              <Definition label="动作约束">{text(selected.raw.actionPolicy, 'unknown')} · {selected.raw.confirmationRequired ? '需要原操作确认' : '仍需本次显式动作'}</Definition>
              <Definition label="插入能力">仅公开槽位可接入；此节点不授予插入权限</Definition>
            </dl>
            <div className="flex flex-wrap gap-2"><Button disabled={unavailable} onClick={() => void controller.action('highlight', selected, '', false, false)}>临时高亮</Button>
              <Badge warning={selected.raw.opaque === true}>{selected.raw.opaque ? '不透明内容' : '仅观测 DOM'}</Badge></div>
            <div className="space-y-3 rounded-md bg-[#F7F8FC] p-3">
              <h4 className="text-sm font-medium">显式节点动作</h4>
              <select aria-label="节点动作类型" className={fieldClass} value={action} onChange={(event) => { setAction(event.currentTarget.value); setConfirmed(false); setAllowUnknown(false); }}>
                <option value="click">点击</option><option value="fill">填值</option><option value="select">选择选项</option><option value="scroll">滚动至节点</option>
              </select>
              {(action === 'fill' || action === 'select') && <textarea aria-label={action === 'select' ? '选项值，每行一项' : '填充值'} className={`${fieldClass} min-h-20 w-full`} value={value}
                onChange={(event) => { setValue(event.currentTarget.value); setConfirmed(false); setAllowUnknown(false); }} placeholder={action === 'select' ? '每行一个选项值' : '原生输入框的新值'} />}
              <Check disabled={state.stale} checked={confirmed} onChange={setConfirmed}>确认对此节点执行本次动作</Check>
              <Check disabled={state.stale} checked={allowUnknown} onChange={setAllowUnknown}>允许未知副作用，可能间接影响设备或外部资源</Check>
              <Button disabled={unavailable || !confirmed || !allowUnknown} primary onClick={() => { void controller.action(action, selected, value, confirmed, allowUnknown); setConfirmed(false); setAllowUnknown(false); }}>执行一次</Button>
            </div>
            <JsonDetails value={selected.raw.layout ?? null} label="布局与裁切证据" /><JsonDetails value={selected.raw} label="节点属性与元数据" />
          </>}
          <p className="text-xs text-[#556176]">快照 <code>{state.tree.id}</code> · {new Date(state.tree.observedAt).toLocaleString()} · 覆盖 {text(coverage.completeness, '未知')}{array(coverage.truncation).length ? ' · 已截断' : ''}</p>
        </section>
      </div>}
    {state.target?.kind === 'browser' && <details className="rounded-lg border border-[#E6EAF3] p-3 text-[13px]"><summary className="cursor-pointer font-medium">快照差异与结构断言</summary>
      <div className="mt-3 flex flex-wrap items-center gap-2"><label>差异前 <select aria-label="差异前快照" className={fieldClass} value={before} onChange={(event) => setBefore(event.currentTarget.value)}><option value="">选择快照</option>{state.trees.map((tree) => <option key={tree.id}>{tree.id}</option>)}</select></label>
        <label>差异后 <select aria-label="差异后快照" className={fieldClass} value={after} onChange={(event) => setAfter(event.currentTarget.value)}><option value="">选择快照</option>{state.trees.map((tree) => <option key={tree.id}>{tree.id}</option>)}</select></label>
        <Button disabled={unavailable || !before || !after || before === after} onClick={() => void controller.diff(before, after)}>比较差异</Button></div>
      <label className="mt-3 block text-[#556176]">断言 JSON<textarea aria-label="结构断言 JSON" className={`${fieldClass} mt-1 min-h-20 w-full font-mono`} value={assertion} onChange={(event) => setAssertion(event.currentTarget.value)} /></label>
      <p className="my-2 text-xs text-[#556176]">支持 exists / absent / count / enabled / visible / valid 及布局条件；布局证据不足时返回无法判定。</p>
      {inputError && <p role="alert" className="text-[#8A4D00]">{inputError}</p>}
      <Button disabled={unavailable || !state.rootId} onClick={() => parseWork(assertion, controller.assertion)}>执行断言</Button>
    </details>}
  </div>;
}
