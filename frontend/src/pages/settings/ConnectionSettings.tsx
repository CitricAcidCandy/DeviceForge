import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { useAction } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { McpConnection } from './components/McpConnection/index.tsx';
import { settingsButtonClass, settingsInputClass, SettingsFailure } from './primitives.tsx';

export function ConnectionSettings({ services }: { services: ProductServices }) {
  const [baseUrl, setBaseUrl] = useState(
    () => services.connection?.baseUrl ?? (typeof location === 'undefined' ? '' : location.origin),
  );
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [submittedAddress, setSubmittedAddress] = useState<string | null>(null);
  const action = useAction();
  const connection = services.connection;
  return (
    <>
      <form
        className="mt-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (!connection || action.pending) return;
          try {
            const address = new URL(baseUrl.trim());
            if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error();
          } catch {
            setValidation('请输入完整服务地址，以 http:// 或 https:// 开头。');
            return;
          }
          setValidation(null);
          setSubmittedAddress(baseUrl.trim());
          void action.run((signal) => connection.reconnect(baseUrl.trim(), token, signal), {
            quiet: true,
            errorFeedback: 'inline',
          });
        }}
      >
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-[104px_minmax(0,520px)] sm:gap-y-6">
          <Label htmlFor="settings-server-url" className="min-h-9 text-[14px] font-normal text-body">
            服务地址
          </Label>
          <Input
            id="settings-server-url"
            className={`${settingsInputClass} font-mono!`}
            value={baseUrl}
            disabled={!connection}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setValidation(null);
            }}
            placeholder="http://127.0.0.1:7031"
            autoComplete="url"
            spellCheck={false}
            aria-invalid={Boolean(validation)}
            aria-describedby={validation ? 'settings-address-error' : undefined}
          />
          <Label htmlFor="settings-server-token" className="min-h-9 self-start text-[14px] font-normal text-body">
            可选令牌
          </Label>
          <div className="min-w-0">
            <div className="relative">
              <Input
                id="settings-server-token"
                className={`${settingsInputClass} pr-16`}
                value={token}
                disabled={!connection}
                onChange={(event) => setToken(event.target.value)}
                type={showToken ? 'text' : 'password'}
                placeholder="留空即免鉴权"
                autoComplete="off"
                aria-describedby="settings-token-hint"
              />
              <Button
                type="button"
                variant="ghost"
                className="absolute top-1 right-1 h-7 rounded px-2 text-[12px]! font-normal text-muted-foreground"
                disabled={!connection}
                aria-label={showToken ? '隐藏服务令牌' : '显示服务令牌'}
                aria-pressed={showToken}
                onClick={() => setShowToken((value) => !value)}
              >
                {showToken ? '隐藏' : '显示'}
              </Button>
            </div>
            <p id="settings-token-hint" className="mt-1! text-[12px] leading-6 text-muted-foreground">
              仅当前会话使用，不保存到浏览器。
            </p>
          </div>
        </div>
        {!connection && (
          <p className="mt-3! text-[12px] text-muted-foreground sm:ml-32!">
            当前宿主使用同源服务，未提供切换连接能力。
          </p>
        )}
        <div className="mt-[14px] flex flex-wrap items-start gap-x-6 gap-y-3 sm:ml-32">
          <Button
            type="submit"
            className={`${settingsButtonClass} w-[116px]`}
            disabled={!connection || action.pending}
          >
            {action.pending ? '正在测试…' : action.error ? '重新测试' : '测试并应用'}
          </Button>
          <p className="text-[12px] leading-[24px] text-muted-foreground">
            切换服务会结束当前工作会话；
            <br />
            已提交任务仍由原服务处理。
          </p>
          {action.pending && (
            <Button type="button" variant="ghost" className={`${settingsButtonClass} px-2 font-normal text-muted-foreground`} onClick={action.cancel}>
              取消等待
            </Button>
          )}
        </div>
        {validation ? (
          <p id="settings-address-error" role="alert" className="mt-5! text-[13px] text-destructive sm:ml-32!">
            {validation}
          </p>
        ) : action.error && submittedAddress === baseUrl.trim() ? (
          <div className="mt-3 sm:ml-32">
            <SettingsFailure error={action.error} logId={action.logId} noLogMessage="未取得日志 ID。" />
          </div>
        ) : null}
      </form>
      <MarketplaceSettings services={services} />
      <details className="group mt-[34px] border-t border-hairline pt-[22px]">
        <summary className="flex min-h-7 list-none items-center gap-[10px] py-0! text-[14px]! font-normal! text-body [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-[18px]! text-muted-foreground group-open:rotate-90" aria-hidden="true" />
          MCP 连接与工具目录
        </summary>
        <div className="pt-5">
          <McpConnection services={services} />
        </div>
      </details>
    </>
  );
}

function MarketplaceSettings({ services }: { services: ProductServices }) {
  const [draft, setDraft] = useState(() => services.marketplace.currentUrl());
  const action = useAction();
  return (
    <section className="mt-[26px] border-t border-hairline pt-6">
      <h3 className="text-[15px]! leading-7! font-medium! text-ink">插件市场</h3>
      <form
        className="mt-[14px] grid gap-x-6 gap-y-3 sm:grid-cols-[104px_minmax(0,1fr)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (action.pending) return;
          void action.run(async () => {
            const value = services.marketplace.setUrl(draft);
            setDraft(value);
            window.dispatchEvent(new Event('deviceforge-marketplace-change'));
            return { data: { url: value }, logId: null };
          }, { success: '市场地址已保存并刷新' });
        }}
      >
        <Label htmlFor="settings-marketplace-url" className="min-h-9 self-start text-[14px] font-normal text-body">
          市场地址
        </Label>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Input
              id="settings-marketplace-url"
              className={`${settingsInputClass} w-full font-mono! min-[1200px]:w-[360px]`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="http://127.0.0.1:7040"
              spellCheck={false}
              aria-describedby="settings-marketplace-hint"
            />
            <Button type="submit" variant="outline" className={`${settingsButtonClass} px-3`} disabled={action.pending}>
              保存并刷新
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={`${settingsButtonClass} px-2 font-normal text-body`}
              disabled={action.pending}
              onClick={() => {
                void action.run(async () => {
                  const value = services.marketplace.resetUrl();
                  setDraft(value);
                  window.dispatchEvent(new Event('deviceforge-marketplace-change'));
                  return { data: { url: value }, logId: null };
                }, { success: '市场地址已恢复默认' });
              }}
            >
              恢复默认
            </Button>
          </div>
          <p id="settings-marketplace-hint" className="mt-1! text-[12px] leading-6 text-muted-foreground">
            仅当前浏览器生效
          </p>
          {action.error ? (
            <div className="mt-3">
              <SettingsFailure error={action.error} logId={action.logId} />
            </div>
          ) : null}
        </div>
      </form>
    </section>
  );
}
