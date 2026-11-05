import { useEffect, useId, useState } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import {
  SETTINGS_CONNECTION_SERVICE, SETTINGS_MCP_SERVICE, MARKETPLACE_PREFERENCES_SERVICE,
  connectionState, marketAddress, mcpTools, platformCall,
} from '../platform.ts';
import type { ConnectionState, McpTool } from '../platform.ts';
import { Button, Input, Label, errorLogId, useAction } from '../view-support.tsx';
import { SettingsFailure, settingsButtonClass, settingsInputClass } from './primitives.tsx';
import { usePlatformFeature } from './platform-feature.ts';

export function ConnectionSettings({ context }: { context: HostContext }) {
  const formId = useId();
  const [state, setState] = useState<ConnectionState | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [baseUrl, setBaseUrl] = useState(''), [token, setToken] = useState(''), [showToken, setShowToken] = useState(false);
  const action = useAction();
  const connection = usePlatformFeature(context, SETTINGS_CONNECTION_SERVICE);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setReadError(null); setToken('');
    if (connection) {
      void platformCall(connection, SETTINGS_CONNECTION_SERVICE, { action: 'status' }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        const value = connectionState(result.data);
        setState(value); setBaseUrl(value.baseUrl);
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { setState(null); setReadError(reason); }
      });
    }
    return () => controller.abort();
  }, [connection]);
  return <>
    <form className="mt-7" onSubmit={(event) => {
      event.preventDefault();
      if (!connection || !state?.canReconnect || action.pending) return;
      void action.run(async (signal) => {
        const address = new URL(baseUrl.trim());
        if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password)
          throw new Error('请输入不含凭据的完整 HTTP 服务地址');
        const result = await platformCall(connection, SETTINGS_CONNECTION_SERVICE, { action: 'reconnect', baseUrl: address.origin, token }, signal);
        if (!signal.aborted) { const next = connectionState(result.data); setState(next); setBaseUrl(next.baseUrl); setToken(''); }
        return result;
      });
    }}>
      <div className="grid gap-x-6 gap-y-3 @lg/settings-content:grid-cols-[104px_minmax(0,520px)] @lg/settings-content:gap-y-6">
        <Label htmlFor={`${formId}-server-url`} className="min-h-9 text-sm font-normal text-body">服务地址</Label>
        <Input id={`${formId}-server-url`} className={`${settingsInputClass} font-mono`} value={baseUrl}
          disabled={!state?.canReconnect} onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://127.0.0.1:7031" autoComplete="url" spellCheck={false} />
        <Label htmlFor={`${formId}-server-token`} className="min-h-9 text-sm font-normal text-body">可选令牌</Label>
        <div className="min-w-0">
          <div className="relative">
            <Input id={`${formId}-server-token`} className={`${settingsInputClass} pr-16`} value={token}
              disabled={!state?.canReconnect} onChange={(event) => setToken(event.target.value)}
              type={showToken ? 'text' : 'password'} placeholder="留空即免鉴权" autoComplete="off" />
            <Button type="button" variant="ghost" className="absolute right-1 top-1 h-7 px-2 text-xs"
              disabled={!state?.canReconnect} aria-pressed={showToken} onClick={() => setShowToken((value) => !value)}>
              {showToken ? '隐藏' : '显示'}
            </Button>
          </div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">仅当前会话使用，不保存到浏览器。</p>
        </div>
      </div>
      {!connection && <p role="status" className="mt-3 text-xs text-muted-foreground">平台尚未提供公开连接管理服务；当前工作区仍可使用。</p>}
      <SettingsFailure error={readError} logId={errorLogId(readError)} />
      <div className="mt-4 flex flex-wrap items-start gap-6 @lg/settings-content:ml-32">
        <Button type="submit" className={settingsButtonClass} disabled={!state?.canReconnect || action.pending}>
          {action.pending ? '正在测试…' : '测试并应用'}
        </Button>
        <p className="text-xs leading-6 text-muted-foreground">切换服务会结束当前工作会话；已提交任务仍由原服务处理。</p>
        {action.pending && <Button type="button" variant="ghost" onClick={action.cancel}>取消等待</Button>}
      </div>
      <SettingsFailure error={action.error} logId={action.logId} />
    </form>
    <MarketplaceSettings context={context} />
    <McpConnection context={context} baseUrl={state?.baseUrl ?? null} />
  </>;
}
function MarketplaceSettings({ context }: { context: HostContext }) {
  const formId = useId();
  const [draft, setDraft] = useState(''), [ready, setReady] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const action = useAction();
  const preferences = usePlatformFeature(context, MARKETPLACE_PREFERENCES_SERVICE);
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setReadError(null);
    if (preferences)
      void platformCall(preferences, MARKETPLACE_PREFERENCES_SERVICE, { action: 'get' }, controller.signal).then((result) => {
        if (!controller.signal.aborted) { setDraft(marketAddress(result.data)); setReady(true); }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { setReady(false); setReadError(reason); }
      });
    return () => controller.abort();
  }, [preferences]);
  async function change(actionName: 'set' | 'reset', signal: AbortSignal) {
    if (!preferences) throw new Error('市场地址功能当前不可用');
    const result = await platformCall(preferences, MARKETPLACE_PREFERENCES_SERVICE,
      actionName === 'set' ? { action: 'set', url: draft } : { action: 'reset' }, signal);
    if (!signal.aborted) setDraft(marketAddress(result.data));
    return result;
  }
  return <section className="mt-7 border-t border-hairline pt-6">
    <h3 className="text-[15px] font-medium text-ink">插件市场</h3>
    <form className="mt-4 flex flex-wrap items-center gap-3" onSubmit={(event) => {
      event.preventDefault(); if (ready) void action.run((signal) => change('set', signal));
    }}>
      <Label htmlFor={`${formId}-marketplace-url`}>市场地址</Label>
      <Input id={`${formId}-marketplace-url`} className={`${settingsInputClass} max-w-[360px] font-mono`} value={draft}
        disabled={!ready || action.pending} onChange={(event) => setDraft(event.target.value)} placeholder="http://127.0.0.1:7040" />
      <Button type="submit" variant="outline" disabled={!ready || action.pending}>保存地址</Button>
      <Button type="button" variant="ghost" disabled={!ready || action.pending} onClick={() => { void action.run((signal) => change('reset', signal)); }}>恢复默认</Button>
    </form>
    {!preferences && <p className="mt-2 text-xs text-muted-foreground">市场插件未提供地址设置，启用后可在此修改。</p>}
    <SettingsFailure error={readError} logId={errorLogId(readError)} />
    <SettingsFailure error={action.error} logId={action.logId} />
  </section>;
}
function McpConnection({ context, baseUrl }: { context: HostContext; baseUrl: string | null }) {
  const [tools, setTools] = useState<readonly McpTool[] | null>(null);
  const action = useAction();
  const mcp = usePlatformFeature(context, SETTINGS_MCP_SERVICE);
  useEffect(() => { setTools(null); }, [mcp]);
  const canRead = mcp !== null;
  return <details className="mt-8 border-t border-hairline pt-5">
    <summary className="text-sm text-body">MCP 连接与工具目录</summary>
    <section className="mt-5 flex flex-col gap-4 text-[13px]">
      {baseUrl && <p>服务地址：<code className="break-all">{new URL('/mcp', baseUrl).href}</code></p>}
      <p className="text-xs leading-6 text-muted-foreground">供支持 MCP 的客户端接入；这里核对真实目录，不代替工具执行验收。</p>
      <Button variant="outline" className="self-start" disabled={!canRead || action.pending} onClick={() => {
        void action.run(async (signal) => {
          if (!mcp) throw new Error('MCP 目录功能当前不可用');
          const result = await platformCall(mcp, SETTINGS_MCP_SERVICE, { action: 'listTools' }, signal);
          if (!signal.aborted) setTools(mcpTools(result.data));
          return result;
        });
      }}>读取 MCP 工具目录</Button>
      {!canRead && <p role="status" className="text-xs text-muted-foreground">平台尚未提供公开 MCP 目录能力；不能据此判断服务器离线。</p>}
      <SettingsFailure error={action.error} logId={action.logId} />
      {tools && <div className="divide-y divide-hairline">
        {!tools.length && <p className="py-3 text-xs text-muted-foreground">服务器返回空工具目录。</p>}
        {tools.map((tool) => <article key={tool.name} className="py-3">
          <h4 className="font-medium">{tool.title ?? tool.name}</h4>
          <code className="break-all text-xs text-muted-foreground">{tool.name}</code>
          <p className="mt-1">{tool.description ?? '没有公开说明'}</p>
          <details className="mt-2"><summary>输入契约</summary><pre className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
        </article>)}
      </div>}
    </section>
  </details>;
}
