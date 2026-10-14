import { useState } from 'react';
import { Button } from '../../../components/ui/button.tsx';
import { Field, PageTitle, EmptyState, JsonResult } from '../../../components/common/index.ts';
import { ActionFeedback } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import type { ProductServices } from '../services.ts';

export function TerminalPage({services}: {services: ProductServices}) {
  const session = services.sessions;
  const snapshot = useSnapshot(session);
  const action = useAction();
  const reader = useAction();
  const [profile, setProfile] = useState('default');
  const [command, setCommand] = useState('');
  const [resumeId, setResumeId] = useState('');
  const terminalAvailable = snapshot.definitions?.sessions.some((item) => item.id === 'plugin.terminal.open') ?? false;
  const decoder = new TextDecoder();
  const text = snapshot.chunks.map((chunk) => decoder.decode(Uint8Array.from(chunk.bytes), {stream: true})).join('') + (snapshot.session?.status === 'finished' ? decoder.decode() : '');
  return <section className="product-page"><PageTitle eyebrow="深度调试" title="终端" description="使用服务器已配置的终端档案。会话、输入回执和输出序号均来自真实服务。"><Button variant="outline" onClick={() => void action.run(async signal => { await session.refreshDefinitions(signal); return session.refreshRecords(signal); })}>刷新会话目录</Button></PageTitle>
    <div className="form-row"><Field label="终端档案" value={profile} onChange={setProfile} hint="仅使用服务器预先配置的档案 ID" /><Button disabled={!terminalAvailable || action.pending} onClick={() => void action.run(signal => session.openTerminal(profile, signal))}>打开终端</Button><Field label="恢复会话 ID" value={resumeId} onChange={setResumeId} /><Button variant="outline" disabled={!resumeId || action.pending} onClick={() => void action.run(signal => session.resume(resumeId, signal))}>恢复</Button></div>
    {!terminalAvailable && <p className="capability-notice">先刷新目录；服务器需要发布终端插件，并配置可用档案。</p>}
    {snapshot.records.length > 0 && <div className="session-list">{snapshot.records.filter(item => item.operation === 'plugin.terminal.open').map(item => <Button key={item.id} variant="ghost" onClick={() => void action.run(signal => session.resume(item.id, signal))}>{item.id.slice(0, 8)} · {item.status}</Button>)}</div>}
    <div className="terminal-output" role="log" aria-label="终端输出">{text ? <pre>{text}</pre> : <EmptyState title="等待终端输出" description="打开或恢复会话后读取输出。取消页面等待不会自动终止服务器会话。" />}</div>
    <div className="form-row"><Field label="终端输入" value={command} onChange={setCommand} placeholder="输入命令后发送" /><Button disabled={!snapshot.session || snapshot.inputState !== 'writable' || action.pending} onClick={() => void action.run(async signal => { const result = await session.send([...new TextEncoder().encode(command + '\n')], signal); setCommand(''); return result; })}>发送</Button><Button variant="outline" disabled={!snapshot.session || reader.pending} onClick={() => void reader.run(signal => session.pollOutput({limit: 100}, signal))}>持续读取</Button><Button variant="ghost" disabled={!reader.pending} onClick={reader.cancel}>暂停读取</Button></div>
    <div className="action-row"><Button variant="outline" disabled={!snapshot.session} onClick={() => void action.run(signal => session.query(signal))}>重查状态</Button><Button variant="outline" disabled={!snapshot.session || snapshot.inputState === 'eof'} onClick={() => void action.run(signal => session.eof(signal))}>关闭输入</Button><Button variant="destructive" disabled={!snapshot.session || snapshot.session.status === 'finished'} onClick={() => void action.run(signal => session.cancel(signal))}>停止会话</Button><Button variant="ghost" disabled={snapshot.session?.status !== 'finished'} onClick={() => void action.run(signal => session.remove(signal))}>删除已结束记录</Button></div>
    <p className="muted">状态：{snapshot.session?.status ?? '尚未打开'} · 输出序号 {snapshot.cursor} · 输入 {snapshot.inputState}</p><ActionFeedback {...action} /><ActionFeedback {...reader} /><JsonResult value={snapshot.session} />
  </section>;
}
