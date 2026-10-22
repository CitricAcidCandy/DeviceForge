import { useEffect, useRef, useState } from 'react';
import { Button } from '../Button/index.tsx';
import { DialogShell } from '../DialogShell/index.tsx';
import { SchemaForm } from '../SchemaForm/index.tsx';
import { hasSchemaFields, readonlyIssues } from '../../utils/schema.ts';
import type { SchemaValue, SchemaIssue } from '../../utils/schema.ts';

export interface ConfigurationDialogValue {
  readonly definition: { readonly version: number; readonly schema: SchemaValue; readonly defaults: SchemaValue; readonly apply_policy: 'next_invocation' | 'plugin_reload' } | null;
  readonly values: SchemaValue;
  readonly revision: string;
  readonly pendingReload: boolean;
  readonly compatible: boolean;
  readonly fieldErrors: readonly SchemaIssue[];
  readonly source: 'legacy' | 'managed' | 'defaults';
}
export interface PluginConfigurationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly load: (signal: AbortSignal) => Promise<ConfigurationDialogValue>;
  readonly save: (revision: string, values: SchemaValue, signal: AbortSignal) => Promise<ConfigurationDialogValue>;
  readonly reset: (revision: string, signal: AbortSignal) => Promise<ConfigurationDialogValue>;
  readonly apply: (revision: string, signal: AbortSignal) => Promise<ConfigurationDialogValue>;
  readonly onApplied?: () => void;
}

function failureDetails(reason: unknown): { message: string; logId: string | null } {
  return {
    message: reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '配置操作失败',
    logId: reason !== null && typeof reason === 'object' && 'logId' in reason &&
      typeof reason.logId === 'string' && reason.logId.trim() ? reason.logId : null,
  };
}

export function PluginConfigurationDialog({ open, title, onClose, load, save, reset, apply, onApplied }: PluginConfigurationDialogProps) {
  const [snapshot, setSnapshot] = useState<ConfigurationDialogValue | null>(null);
  const [values, setValues] = useState<SchemaValue>({});
  const [errors, setErrors] = useState<readonly SchemaIssue[]>([]);
  const [error, setFailure] = useState<ReturnType<typeof failureDetails> | null>(null);
  const setError = (reason: unknown) => setFailure(reason ? failureDetails(reason) : null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const current = useRef({ load, save, reset, apply, onApplied });
  current.current = { load, save, reset, apply, onApplied };
  useEffect(() => {
    setSnapshot(null); setError(''); setFeedback(''); setErrors([]);
    if (!open) return;
    const controller = new AbortController(); request.current = controller; setBusy(true);
    void current.current.load(controller.signal).then((result) => {
      if (!controller.signal.aborted) { setSnapshot(result); setValues(result.values); setErrors(result.fieldErrors); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); if (request.current === controller) request.current = null; });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [open, title, refresh]);
  async function run(action: 'save' | 'reset' | 'apply' | 'saveApply') {
    if (!snapshot || busy || request.current) return;
    if (action === 'save' || action === 'saveApply') {
      const issues = snapshot.definition ? readonlyIssues(snapshot.definition.schema, snapshot.values, values) : [];
      setErrors(issues);
      if (issues.length) { setError('配置不符合字段约束，请修正后保存'); return; }
    }
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setFeedback('');
    try {
      let result = action === 'reset' ? await current.current.reset(snapshot.revision, controller.signal)
        : action === 'apply' ? await current.current.apply(snapshot.revision, controller.signal)
        : await current.current.save(snapshot.revision, values, controller.signal);
      controller.signal.throwIfAborted();
      if (!result.compatible || result.fieldErrors.length) { setErrors(result.fieldErrors); setError('保存被拒绝，原配置未改变；请修正字段后重试'); return; }
      if (action === 'saveApply' && result.pendingReload) {
        setSnapshot(result); setValues(result.values); setErrors(result.fieldErrors); setFeedback('配置已保存，正在重载插件…');
        result = await current.current.apply(result.revision, controller.signal);
      }
      controller.signal.throwIfAborted();
      setSnapshot(result); setValues(result.values); setErrors(result.fieldErrors);
      setFeedback(result.pendingReload ? '配置已保存，重载插件后生效' : action === 'reset' ? '已恢复默认配置' : '配置已保存并生效');
      if (action === 'apply' || action === 'saveApply') current.current.onApplied?.();
    } catch (reason) { if (!controller.signal.aborted) setError(reason); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  function close() { request.current?.abort(); onClose(); }
  async function copyLogId(logId: string) {
    try { await navigator.clipboard.writeText(logId); setFeedback('日志 ID 已复制'); }
    catch { setFeedback('复制失败，请手动选择日志 ID'); }
  }
  const configurable = snapshot?.definition && hasSchemaFields(snapshot.definition.schema);
  return <DialogShell open={open} onOpenChange={(next) => { if (!next) close(); }} title={`配置 · ${title}`} description="配置由插件声明，并在保存前校验。" size="lg" footer={<>
    <Button type="button" variant="outline" onClick={close}>关闭</Button>
    {(snapshot || error) && <Button type="button" variant="outline" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>重新读取</Button>}
    {configurable && snapshot?.definition && <>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void run('reset')}>恢复默认</Button>
      <Button type="button" disabled={busy} onClick={() => void run('save')}>保存配置</Button>
      {snapshot.definition.apply_policy === 'plugin_reload' && <Button type="button" disabled={busy} onClick={() => void run('saveApply')}>保存并重载</Button>}
      {snapshot.pendingReload && <Button type="button" variant="outline" disabled={busy} onClick={() => void run('apply')}>应用已保存配置</Button>}
    </>}
  </>}>
    {busy && !snapshot && <p role="status">正在读取插件配置…</p>}
    {error && <div className="form-error" role="alert">
      <p>{error.message}</p>
      {error.logId && <p>日志 ID：<code>{error.logId}</code> <Button type="button" variant="ghost" size="sm" onClick={() => void copyLogId(error.logId ?? '')}>复制日志 ID</Button></p>}
    </div>}
    {feedback && <p className="form-success" role="status">{feedback}</p>}
    {snapshot && !configurable && <p role="status">此插件无需配置。</p>}
    {configurable && snapshot?.definition && <>
      <p className="muted">Schema v{snapshot.definition.version} · {snapshot.source === 'legacy' ? '来自旧版配置' : snapshot.source === 'managed' ? '已保存配置' : '默认配置'} · {snapshot.definition.apply_policy === 'plugin_reload' ? '重载插件后生效' : '下次调用生效'}</p>
      {!snapshot.compatible && <p className="form-error" role="alert">当前配置与插件版本不兼容，插件启用前需修正或恢复默认。</p>}
      <SchemaForm schema={snapshot.definition.schema} value={values} disabled={busy} errors={errors} onChange={(next) => { setValues(next); setFeedback(''); }} />
    </>}
  </DialogShell>;
}
