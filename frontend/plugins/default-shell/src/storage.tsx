import { useEffect, useRef, useState } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';

interface StorageState {
  readonly enabled: boolean;
  readonly state: string;
  readonly source: string;
  readonly pending: boolean;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}
function readStatus(value: unknown): StorageState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !('enabled' in value) || typeof value.enabled !== 'boolean' ||
    !('state' in value) || typeof value.state !== 'string' ||
    !('source' in value) || typeof value.source !== 'string' ||
    !('pending' in value) || typeof value.pending !== 'boolean' || !('lastError' in value)) return null;
  let lastError: StorageState['lastError'] = null;
  if (value.lastError !== null) {
    const error = value.lastError;
    if (!error || typeof error !== 'object' || !('code' in error) ||
      typeof error.code !== 'string' || !('message' in error) || typeof error.message !== 'string') return null;
    lastError = { code: error.code, message: error.message };
  }
  return {
    enabled: value.enabled, state: value.state, source: value.source, pending: value.pending,
    lastError,
  };
}
export function StorageStatus({ context }: { readonly context: HostContext }) {
  const [status, setStatus] = useState<StorageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const service = { id: 'host.workspace.storage', version: '1' };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const accept = (value: unknown) => { if (!signal.aborted) { const result = readStatus(value); if (result) setStatus(result); } };
    const unsubscribe = context.extensions?.subscribeEvent('host.workspace.storage.changed', (event) => accept(event.data));
    if (context.services) void context.services.call(service, { action: 'status' }, signal).then((result) => accept(result.data),
      () => { if (!signal.aborted) setError('当前无法查询布局保存状态'); });
    return () => { controller.abort(); void unsubscribe?.(); };
  }, [context]);
  async function action(value: 'retryRead' | 'saveCurrent') {
    const controller = lifetime.current;
    if (!controller || busy || !context.services) return;
    const signal = AbortSignal.any([controller.signal, context.signal]);
    setBusy(true); setError(null);
    try {
      const result = await context.services.call(service, { action: value }, signal);
      const next = readStatus(result.data);
      if (!signal.aborted && next) setStatus(next);
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : '布局存储操作失败'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  const healthy = status?.enabled && status.state === 'ready';
  const label = healthy ? status.pending ? '布局正在保存' : '布局自动保存已启用'
    : status?.enabled ? '布局保存受阻' : '布局保存状态未提供';
  return <details className="relative min-w-0">
    <summary className={`cursor-pointer truncate ${status?.enabled && !healthy ? 'text-[#A65D0D]' : 'text-[#596479]'}`}>{label}</summary>
    <div className="absolute bottom-7 left-0 z-[300] w-80 max-w-[80vw] rounded-xl border border-[#E6EAF3] bg-white p-4 text-xs leading-6 shadow-xl">
      <p className="font-semibold text-[#222631]">{label}</p>
      <p className="mt-2 text-[#596479]">{status?.lastError?.message ?? error ?? (healthy
        ? '布局变化由平台保存。页面与插件会话仍各自管理业务数据和草稿。'
        : '当前工作区仍可使用。此处只报告平台实际返回的保存状态。')}</p>
      {(error || status?.lastError) && <p className="mt-2 text-[#A65D0D]">重新读取不会自动覆盖当前编辑；保存当前布局会替换已存储的布局内容。</p>}
      {status?.enabled && !healthy && <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} className="rounded-lg border border-[#E6EAF3] px-3 py-2 disabled:opacity-40" onClick={() => { void action('retryRead'); }}>重新读取</button>
        <button type="button" disabled={busy} className="rounded-lg bg-[#6C4CF5] px-3 py-2 text-white disabled:opacity-40" onClick={() => { void action('saveCurrent'); }}>保存当前布局</button>
      </div>}
    </div>
  </details>;
}
