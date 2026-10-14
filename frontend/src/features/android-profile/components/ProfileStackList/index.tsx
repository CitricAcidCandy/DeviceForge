import { useEffect, useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../../components/Table/index.tsx';
import { EmptyState } from '../../../../components/EmptyState/index.tsx';
import type { ProfileFrameAssociation } from '../../types/index.ts';

export function ProfileStackList({ associations }: { associations: readonly ProfileFrameAssociation[] }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [associations]);
  const offset = page * 25;
  const visible = associations.slice(offset, offset + 25);
  if (associations.length === 0) return <EmptyState title="此区间没有关联栈" description="没有用相邻栈或最近一帧补齐关联；无 Root 时仍可查看已有指标。" />;
  return <div className="profile-stacks">
    <p className="muted">{associations.length} 条实际调用链 · 当前 {offset + 1}–{Math.min(offset + 25, associations.length)}</p>
    {visible.map(({ index, sample }) => <details key={index} className="result-details">
      <summary>栈 {index} · {sample.thread_name ?? '未报告线程名'}（TID {sample.thread_id}）· {sample.time_ns} ns · 深度 {sample.callchain.length}</summary>
      <p>事件：{sample.event_type ?? '未报告'} · 计数 {sample.event_count} · PID {sample.process_id ?? '未报告'}</p>
      {sample.unwinding && <p>展开诊断：{sample.unwinding.error_code ?? '未报告错误码'} · 地址 {sample.unwinding.error_address ?? '未报告'} · 原始码 {sample.unwinding.raw_error_code ?? '未报告'}</p>}
      {sample.callchain.length > 0 ? <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>层级</TableHead><TableHead>符号 / 地址</TableHead><TableHead>模块</TableHead><TableHead>执行类型</TableHead></TableRow></TableHeader><TableBody>
        {sample.callchain.map((frame, depth) => <TableRow key={depth}><TableCell>{depth}</TableCell><TableCell><code>{frame.symbol ?? '未提供符号'}</code><small style={{ display: 'block' }}><code>{frame.address}</code></small></TableCell><TableCell>{frame.file ?? '未提供模块'}</TableCell><TableCell>{frame.execution_type}</TableCell></TableRow>)}
      </TableBody></Table></div> : <p className="muted">此条记录没有非空调用链。</p>}
    </details>)}
    <div className="action-row"><Button variant="outline" disabled={page === 0} onClick={() => setPage(old => old - 1)}>上一页调用链</Button><Button variant="outline" disabled={offset + 25 >= associations.length} onClick={() => setPage(old => old + 1)}>下一页调用链</Button></div>
  </div>;
}
