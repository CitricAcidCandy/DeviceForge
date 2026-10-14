import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../../shared/ui/components/alert.tsx';
import { Button } from '../../shared/ui/components/button.tsx';
import { Input } from '../../shared/ui/components/input.tsx';
import { Label } from '../../shared/ui/components/label.tsx';
import { LoaderCircle, Copy, AlertCircle } from 'lucide-react';
import { errorLogId, useSnapshot } from './hooks.ts';
import type { ProductServices } from './services.ts';

export function ErrorNotice({ error }: {error: unknown}) {
  const [copyState, setCopyState] = useState('');
  if (!error) return null;
  const message = error instanceof Error ? error.message : '操作未完成，请重新查询状态';
  const logId = errorLogId(error);
  return <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>操作未完成</AlertTitle><AlertDescription><p>{message}</p>{logId && <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(logId).then(() => setCopyState('日志 ID 已复制'), () => setCopyState('复制失败，请手动选择日志 ID')); }}><Copy />复制日志 ID：{logId}</Button>}<span role="status">{copyState}</span></AlertDescription></Alert>;
}
export function PageTitle({eyebrow, title, description, children}: {eyebrow?: string; title: string; description?: string; children?: ReactNode}) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</header>;
}
export function EmptyState({title, description}: {title: string; description?: string}) {
  return <div className="empty-state"><h3>{title}</h3>{description && <p>{description}</p>}</div>;
}
export function JsonResult({value}: {value: unknown}) {
  return value == null ? null : <details className="result-details"><summary>查看完整结果</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
export function OperationNotice({services, operation}: {services: ProductServices; operation: string}) {
  const catalog = useSnapshot(services.runtime.operations);
  if (catalog.pending) return <p className="muted"><LoaderCircle className="inline-spinner" />正在核对能力</p>;
  const available = catalog.result?.data.some((item) => item.id === operation) ?? false;
  return available ? null : <p className="capability-notice">当前服务器尚未提供此功能。请在插件页安装或加载对应插件，再刷新目录。</p>;
}
export function useOperationAvailable(services: ProductServices, operation: string): boolean {
  const catalog = useSnapshot(services.runtime.operations);
  return catalog.result?.data.some((item) => item.id === operation) ?? false;
}
export function Field({label, value, onChange, type = 'text', hint, placeholder, min, max}: {label: string; value: string; onChange(value: string): void; type?: string; hint?: string; placeholder?: string; min?: number; max?: number}) {
  const id = useId();
  return <div className="form-field"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} min={min} max={max} />{hint && <small>{hint}</small>}</div>;
}
export function ActionFeedback({pending, error, logId, cancel}: {pending: boolean; error: unknown; logId: string | null; cancel(): void}) {
  return <div aria-live="polite"><ErrorNotice error={error} />{pending && <div className="operation-progress"><LoaderCircle className="inline-spinner" /><span>正在等待真实结果</span><Button variant="ghost" size="sm" onClick={cancel}>取消等待</Button></div>}{logId && !error && <p className="log-id">日志 ID：{logId}</p>}</div>;
}
