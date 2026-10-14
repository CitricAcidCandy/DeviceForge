import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/Table/index.tsx';
import { EmptyState } from '../../components/index.ts';
import { ActionFeedback, ErrorNotice } from './feedback.tsx';
import { useAction } from './hooks.ts';
import type { ProductServices } from './services.ts';

export function McpConnection({services}: {services: ProductServices}) {
  const [snapshot, setSnapshot] = useState(() => services.runtime.mcp.snapshot());
  const [listening, setListening] = useState(false); const [failure, setFailure] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const release = useRef<(() => Promise<void>) | null>(null);
  const action = useAction();
  useEffect(() => () => {controller.current?.abort();}, []);
  const origin = services.connection?.baseUrl ?? (typeof location === 'undefined' ? 'http://localhost:7031' : location.origin);
  return <section className="settings-group"><div className="section-heading"><h2>MCP 连接</h2><span className="text-state">{listening ? '已订阅目录变化' : '未订阅'}</span></div><p>服务地址：<span className="mono">{new URL('/mcp', origin).href}</span></p><p className="muted">供支持 MCP 的客户端接入。这里核对真实工具目录；工具执行仍由对应客户端发起。</p><div className="action-row"><Button variant="outline" disabled={action.pending} onClick={() => void action.run(async signal => {const result = await services.runtime.mcp.listTools(signal); if (!signal.aborted) setSnapshot(result); return result;})}>读取 MCP 工具目录</Button><Button variant="outline" disabled={listening || action.pending} onClick={() => void action.run(async signal => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current; setFailure(null);
    const active = AbortSignal.any([signal, current.signal]);
    const stop = await services.runtime.mcp.subscribe({changed: next => {if (!active.aborted) setSnapshot(next);}, error: error => {if (!active.aborted) {setFailure(error); setListening(false);}}}, active);
    if (active.aborted) {await stop(); return;}
    release.current = stop; setListening(true); return {logId: services.runtime.mcp.snapshot().logId};
  })}>订阅目录变化</Button><Button variant="ghost" disabled={!listening} onClick={() => void action.run(async () => {controller.current?.abort(); await release.current?.(); release.current = null; setListening(false);})}>停止订阅</Button></div><ErrorNotice error={failure} /><ActionFeedback {...action} />
    {snapshot.version === 0 ? <EmptyState title="尚未读取 MCP 目录" description="目录来源与 HTTP 操作目录独立核对，不用操作数代替 MCP 工具数。" /> : snapshot.tools.length === 0 ? <p className="muted">服务器返回空工具目录。</p> : <Table><TableHeader><TableRow><TableHead>工具</TableHead><TableHead>说明</TableHead></TableRow></TableHeader><TableBody>{snapshot.tools.map(tool => <TableRow key={tool.name}><TableCell>{tool.title ?? tool.name}<small className="mono">{tool.name}</small></TableCell><TableCell>{tool.description ?? '没有公开说明'}<details><summary>输入契约</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></TableCell></TableRow>)}</TableBody></Table>}
  </section>;
}
