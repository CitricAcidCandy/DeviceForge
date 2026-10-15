import { useEffect, useMemo, useState } from 'react';
import { PackagePlus, RefreshCw, Play, Square, Trash2, Puzzle } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { Textarea } from '../../components/Textarea/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/Dialog/index.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/Tabs/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import type { PackageKind } from '../../services/api/index.ts';
import { isJsonValue } from '../../plugin-sdk/json.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { EmptyState, JsonResult, PageTitle } from '../../components/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';

export function PluginsPage({ services }: { services: ProductServices }) {
  const [kind, setKind] = useState<PackageKind>('server');
  const [file, setFile] = useState<File | null>(null);
  const action = useAction();
  const defaults = useSnapshot(services.pluginDefaults);
  const defaultFailures = defaults.results.filter((entry) => entry.status === 'failed');
  const defaultEnabled = defaults.results.filter((entry) => entry.status !== 'failed');
  async function copyDefaultLog(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      services.messages.success('日志 ID 已复制');
    } catch {
      services.messages.warning('复制失败，请手动选择日志 ID');
    }
  }
  const server = useSnapshot(services.runtime.serverPlugins);
  const directorySource = useMemo(
    () => ({
      snapshot: () => services.runtime.pluginPackages.snapshot(kind),
      subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) =>
        services.runtime.pluginPackages.subscribe(kind, listener),
    }),
    [services, kind],
  );
  const directory = useSnapshot(directorySource);
  const themes = useSnapshot(services.runtime.themes);
  const [browserRunning, setBrowserRunning] = useState(() =>
    services.runtime.webPlugins.snapshot(),
  );
  const [catalog, setCatalog] = useState(() => services.runtime.extensions.catalog());
  const [mounted, setMounted] = useState<ReadonlyMap<string, string>>(new Map());
  const [extensionCall, setExtensionCall] = useState<{
    id: string;
    title: string;
    version: string | null;
  } | null>(null);
  const [extensionInput, setExtensionInput] = useState('{}');
  function syncExtensions() {
    const nextCatalog = services.runtime.extensions.catalog();
    const owners = new Map(
      [...nextCatalog.components, ...nextCatalog.modules].map((entry) => [
        entry.id,
        `${entry.pluginId}:${entry.generation}`,
      ]),
    );
    setBrowserRunning(services.runtime.webPlugins.snapshot());
    setCatalog(nextCatalog);
    // 停用、贡献撤销或换代后，旧挂载状态不能解释新代的同名入口。
    setMounted(
      (current) => new Map([...current].filter(([id, owner]) => owners.get(id) === owner)),
    );
  }
  async function refresh(signal: AbortSignal) {
    // 自动启用复用目录资源；页面读取等待本轮结束，避免彼此撤销请求。
    if (services.pluginDefaults.snapshot().phase === 'running') return;
    await Promise.all([
      services.runtime.pluginPackages.refresh(kind, signal),
      services.runtime.serverPlugins.refresh(signal),
    ]);
    if (!signal.aborted) syncExtensions();
  }
  useEffect(() => {
    if (defaults.phase === 'running') return;
    void action.run(refresh, { quiet: true });
  }, [services, kind, defaults.phase]);
  useEffect(() => {
    if (defaults.phase !== 'running') syncExtensions();
  }, [defaults.phase, defaults.round]);
  const manage = (run: (signal: AbortSignal) => Promise<unknown>) =>
    action.run(async (signal) => {
      try {
        return await run(signal);
      } finally {
        syncExtensions();
      }
    });
  const runDefaults = (run: typeof services.pluginDefaults.restart) => {
    void action.run(
      async (signal) => {
        try {
          const result = await run(signal);
          if (!signal.aborted && result.results.every((entry) => entry.status !== 'failed'))
            services.messages.success('已安装插件核对完成', {
              description: `共 ${result.results.length} 项已启用或保持运行。`,
            });
          return result;
        } finally {
          syncExtensions();
        }
      },
      { success: null, pending: '正在启用已安装插件' },
    );
  };
  function toggleExtension(id: string, module: boolean) {
    void action.run(async () => {
      const currentCatalog = services.runtime.extensions.catalog();
      const entry = (module ? currentCatalog.modules : currentCatalog.components).find(
        (item) => item.id === id,
      );
      if (!entry) {
        syncExtensions();
        throw new Error('扩展已撤销，请使用刷新后的入口');
      }
      const owner = `${entry.pluginId}:${entry.generation}`;
      const removing = mounted.get(id) === owner;
      if (removing) await services.runtime.extensions.unmount(id);
      else if (module) await services.runtime.extensions.mountModule(id);
      else await services.runtime.extensions.mountComponent(id);
      const freshCatalog = services.runtime.extensions.catalog();
      const fresh = [...freshCatalog.components, ...freshCatalog.modules].find(
        (item) => item.id === id,
      );
      setMounted((current) => {
        const next = new Map(current);
        if (removing || !fresh || `${fresh.pluginId}:${fresh.generation}` !== owner)
          next.delete(id);
        else next.set(id, owner);
        return next;
      });
      syncExtensions();
    });
  }
  return (
    <div className="product-page">
      <PageTitle
        eyebrow="WORKSHOP / EXTENSIONS"
        title="给工坊添一项能力"
        description="服务器插件负责业务执行，浏览器插件扩展当前工作空间。"
      >
        <Button
          variant="outline"
          disabled={action.pending || defaults.phase === 'running'}
          onClick={() => {
            void action.run(refresh);
          }}
        >
          <RefreshCw />
          刷新目录
        </Button>
      </PageTitle>
      <section
        className="workspace-section"
        aria-label="已安装插件默认启用"
        data-plugin-defaults={defaults.phase}
        data-phase={defaults.phase}
      >
        <div className="section-heading">
          <div>
            <h2>已安装插件默认启用</h2>
            <p className="muted">
              启动时启用本轮已安装插件；本实例手动停用后保持停用。
              {defaults.phase === 'running'
                ? ' 正在核对并启用…'
                : defaults.phase === 'completed'
                  ? ` 本轮 ${defaultEnabled.length} 项核对通过${defaultFailures.length ? `，${defaultFailures.length} 项失败` : ''}。`
                  : defaults.phase === 'cancelled'
                    ? ' 本轮等待已取消，可重新执行。'
                    : ' 等待启动核对。'}
            </p>
          </div>
          <div className="page-actions">
            {defaultFailures.length > 0 && (
              <Button
                variant="outline"
                disabled={action.pending || defaults.phase === 'running'}
                onClick={() => {
                  runDefaults(services.pluginDefaults.retryFailures);
                }}
              >
                重试失败项
              </Button>
            )}
            <Button
              variant="outline"
              disabled={action.pending || defaults.phase === 'running'}
              onClick={() => {
                runDefaults(services.pluginDefaults.restart);
              }}
            >
              重新执行默认启用
            </Button>
          </div>
        </div>
        {defaultFailures.length > 0 && (
          <details>
            <summary>本轮 {defaultFailures.length} 项失败 · 查看原因和日志 ID</summary>
            {defaultFailures.map((entry) => (
              <div
                className="result-row"
                key={JSON.stringify([entry.kind, entry.id])}
                data-default-plugin-id={entry.id ?? ''}
                data-default-plugin-kind={entry.kind}
                data-default-plugin-status={entry.status}
              >
                <span>
                  {entry.kind === 'server' ? '服务器' : '浏览器'} · {entry.id ?? '安装或运行目录'}
                </span>
                <span className="text-danger">{entry.message}</span>
                {entry.logId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void copyDefaultLog(entry.logId ?? '');
                    }}
                  >
                    复制日志 ID：{entry.logId}
                  </Button>
                )}
              </div>
            ))}
          </details>
        )}
        {defaultEnabled.length > 0 && (
          <details>
            <summary>本轮核对通过 {defaultEnabled.length} 项 · 查看详情</summary>
            {defaultEnabled.map((entry) => (
              <div
                className="result-row"
                key={JSON.stringify([entry.kind, entry.id])}
                data-default-plugin-id={entry.id ?? ''}
                data-default-plugin-kind={entry.kind}
                data-default-plugin-status={entry.status}
              >
                <span>
                  {entry.kind === 'server' ? '服务器' : '浏览器'} · {entry.id}
                </span>
                <span className="muted">
                  {entry.status === 'enabled' ? '本轮已启用' : '启动核对时已在运行'}
                </span>
              </div>
            ))}
          </details>
        )}
      </section>
      <div className="plugin-upload form-row">
        <div className="form-field">
          <Label htmlFor="plugin-kind">部署到</Label>
          <Select
            value={kind}
            onValueChange={(value) => {
              if (value === 'server' || value === 'browser') setKind(value);
            }}
          >
            <SelectTrigger id="plugin-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="server">服务器插件</SelectItem>
              <SelectItem value="browser">浏览器插件</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="form-field grow">
          <Label htmlFor="plugin-file">插件包 · ZIP / TGZ</Label>
          <Input
            id="plugin-file"
            type="file"
            accept=".zip,.tgz,.tar.gz"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <Button
          disabled={!file || action.pending}
          onClick={() => {
            if (file) {
              const mediaType = file.name.toLowerCase().endsWith('.zip')
                ? 'application/zip'
                : 'application/gzip';
              void manage((signal) =>
                services.runtime.pluginPackages.upload(kind, file, mediaType, signal),
              );
            }
          }}
        >
          <PackagePlus />
          提交插件包
        </Button>
      </div>
      <p className="muted">提交完成表示包已部署；启用后才运行。插件按可信代码运行。</p>
      <ActionFeedback {...action} />
      <Tabs
        value={kind}
        onValueChange={(value) => {
          if (value === 'server' || value === 'browser') setKind(value);
        }}
      >
        <TabsList>
          <TabsTrigger value="server">服务器插件</TabsTrigger>
          <TabsTrigger value="browser">浏览器插件</TabsTrigger>
        </TabsList>
        {(['server', 'browser'] as const).map((targetKind) => (
          <TabsContent key={targetKind} value={targetKind}>
            {!directory.pending && directory.result?.data.length === 0 && (
              <EmptyState
                title="还没有部署插件包"
                description="选择 ZIP 或 TGZ 插件包提交，再按需启用。"
              />
            )}
            {directory.result?.data.map((pkg) => {
              const runtime =
                kind === 'server'
                  ? server.result?.data.find((entry) => entry.id === pkg.id)
                  : browserRunning.find((entry) => entry.id === pkg.id);
              const running = runtime?.state === 'loaded';
              const cleanupFailed = Boolean(
                runtime && 'cleanup_failed' in runtime && runtime.cleanup_failed,
              );
              const guarded = cleanupFailed || runtime?.state === 'draining';
              return (
                <div className="plugin-row" key={pkg.id}>
                  <Puzzle aria-hidden="true" />
                  <div className="grow">
                    <h3>
                      {pkg.id}
                      <small>{pkg.version}</small>
                    </h3>
                    <p className={cleanupFailed ? 'text-danger' : 'muted'}>
                      {kind === 'server' ? '服务器插件' : '浏览器插件'} ·{' '}
                      {cleanupFailed
                        ? '资源清理未确认'
                        : runtime?.state === 'draining'
                          ? '正在排空'
                          : running
                            ? '已启用'
                            : '已部署，未启用'}
                    </p>
                    {cleanupFailed && (
                      <p className="text-danger">该代次的外部资源清理未确认，管理操作已暂停。</p>
                    )}
                    <details>
                      <summary>来源与运行信息</summary>
                      <dl className="details-list">
                        <dt>运行方式</dt>
                        <dd>{pkg.runtime}</dd>
                        <dt>公开接口版本</dt>
                        <dd>{pkg.api_version ?? '未声明'}</dd>
                        <dt>入口</dt>
                        <dd className="mono">{pkg.entry_path}</dd>
                      </dl>
                    </details>
                  </div>
                  <div className="row-actions">
                    <Button
                      variant={running || guarded ? 'outline' : 'default'}
                      disabled={action.pending || defaults.phase === 'running' || guarded}
                      onClick={() => {
                        void manage((signal) =>
                          running
                            ? services.runtime.pluginPackages.disable(kind, pkg.id, signal)
                            : services.runtime.pluginPackages.enable(kind, pkg.id, signal),
                        );
                      }}
                    >
                      {running || guarded ? <Square /> : <Play />}
                      {cleanupFailed
                        ? '清理待确认'
                        : runtime?.state === 'draining'
                          ? '正在排空'
                          : running
                            ? '停用'
                            : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={action.pending || running || guarded}
                      aria-label={`删除已部署的 ${pkg.id}`}
                      onClick={() => {
                        void manage((signal) =>
                          services.runtime.pluginPackages.remove(kind, pkg.id, signal),
                        );
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              );
            })}
          </TabsContent>
        ))}
      </Tabs>
      <section className="settings-group">
        <h2>主题贡献</h2>
        <p className="muted">主题切换保留当前设备、任务和结果。</p>
        <Select
          value={themes.selected?.id ?? 'base'}
          onValueChange={(value) => {
            void action.run(async () =>
              services.runtime.themes.select(value === 'base' ? null : value),
            );
          }}
        >
          <SelectTrigger aria-label="选择主题">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="base">工坊默认主题</SelectItem>
            {themes.themes.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                {theme.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
      {kind === 'server' && (
        <section className="settings-group">
          <h2>服务器当前插件</h2>
          <p className="muted">包括随服务器提供的业务插件。设备提供者与浏览器面板分别运行。</p>
          {server.result?.data.map((plugin) => (
            <div className="plugin-row" key={plugin.id}>
              <Puzzle aria-hidden="true" />
              <div className="grow">
                <h3>
                  {plugin.id}
                  <small>{plugin.version}</small>
                </h3>
                <p className={plugin.cleanup_failed ? 'text-danger' : 'muted'}>
                  {plugin.cleanup_failed
                    ? '资源清理未完成'
                    : plugin.state === 'loaded'
                      ? '已加载'
                      : plugin.state === 'draining'
                        ? '正在排空'
                        : '已卸载'}
                  {plugin.protected ? ' · 宿主保护' : ''}
                </p>
                <details>
                  <summary>{plugin.operations.length} 项公开操作</summary>
                  <ul>
                    {plugin.operations.map((operation) => (
                      <li key={operation} className="mono">
                        {operation}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              <Button
                variant="outline"
                disabled={
                  action.pending ||
                  defaults.phase === 'running' ||
                  plugin.protected ||
                  plugin.state === 'draining'
                }
                onClick={() => {
                  void manage((signal) =>
                    plugin.state === 'loaded'
                      ? services.runtime.serverPlugins.unload(plugin.id, signal)
                      : services.runtime.serverPlugins.load(plugin.id, signal),
                  );
                }}
              >
                {plugin.state === 'loaded' ? '卸载' : '加载'}
              </Button>
            </div>
          ))}
        </section>
      )}
      <section className="settings-group">
        <h2>当前扩展入口</h2>
        <p className="muted">
          公开组件槽位为 <span className="mono">workshop.extensions</span>
          ，支持追加或替换扩展区。工坊工作区由宿主保留。
        </p>
        {catalog.modules.length === 0 &&
        catalog.commands.length === 0 &&
        catalog.components.length === 0 ? (
          <p className="muted">启用浏览器插件后，在这里查看它贡献的模块、命令和组件。</p>
        ) : (
          <div className="extension-list">
            {catalog.modules.map((entry) => (
              <Button
                key={entry.id}
                variant="outline"
                disabled={action.pending}
                onClick={() => toggleExtension(entry.id, true)}
              >
                {entry.title} · {mounted.has(entry.id) ? '关闭模块' : '打开模块'}
              </Button>
            ))}
            {catalog.commands.map((entry) => (
              <Button
                key={entry.id}
                variant="outline"
                disabled={action.pending}
                onClick={() => {
                  setExtensionInput('{}');
                  setExtensionCall({ id: entry.id, title: entry.title, version: null });
                }}
              >
                {entry.title} · 执行命令
              </Button>
            ))}
            {catalog.components.map((entry) => (
              <div key={entry.id}>
                <Button
                  variant="outline"
                  disabled={action.pending || entry.slot !== 'workshop.extensions'}
                  onClick={() => toggleExtension(entry.id, false)}
                >
                  {entry.title} · {mounted.has(entry.id) ? '撤销挂载' : '挂载组件'}
                </Button>
                {entry.slot !== 'workshop.extensions' && (
                  <small className="muted">宿主未提供槽位 {entry.slot}</small>
                )}
              </div>
            ))}
          </div>
        )}
        <details>
          <summary>公开扩展服务 · {catalog.services.length} 项</summary>
          <div className="extension-list">
            {catalog.services.map((entry) => (
              <Button
                key={entry.id}
                variant="outline"
                disabled={action.pending}
                onClick={() => {
                  setExtensionInput('{}');
                  setExtensionCall({ id: entry.id, title: entry.id, version: entry.version });
                }}
              >
                {entry.id} · {entry.version}
              </Button>
            ))}
          </div>
        </details>
      </section>
      <Dialog
        open={extensionCall !== null}
        onOpenChange={(open) => {
          if (!open) {
            action.cancel();
            setExtensionCall(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{extensionCall?.title}</DialogTitle>
            <DialogDescription>
              {extensionCall?.version === null
                ? '执行插件命令'
                : `调用公开服务 ${extensionCall?.version ?? ''}`}
              。输入格式由插件公开文档决定，执行结果在此保留。
            </DialogDescription>
          </DialogHeader>
          <div className="form-field">
            <Label htmlFor="extension-input">扩展输入 · JSON</Label>
            <Textarea
              id="extension-input"
              className="code-input"
              rows={7}
              value={extensionInput}
              onChange={(event) => setExtensionInput(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={action.pending || !extensionCall}
              onClick={() => {
                if (extensionCall)
                  void action.run((signal) => {
                    const input: unknown = JSON.parse(extensionInput);
                    if (!isJsonValue(input)) throw new Error('扩展输入须为合法 JSON 值');
                    return extensionCall.version === null
                      ? services.runtime.extensions.executeCommand(extensionCall.id, input, signal)
                      : services.runtime.extensions.callService(
                          extensionCall.id,
                          extensionCall.version,
                          input,
                          signal,
                        );
                  });
              }}
            >
              执行
            </Button>
          </DialogFooter>
          <ActionFeedback {...action} />
          <JsonResult value={action.result} />
        </DialogContent>
      </Dialog>
      <JsonResult value={action.result} />
    </div>
  );
}
