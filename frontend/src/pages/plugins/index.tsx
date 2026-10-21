import { useEffect, useMemo, useState } from 'react';
import { PackagePlus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
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
import { EmptyState, JsonResult } from '../../components/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { PluginConfigurationDialog } from '../../components/PluginConfigurationDialog/index.tsx';
import type { PluginConfigurationTarget } from '../../features/plugin-configurations/index.ts';
import './workspace.css';

type Listing = 'all' | PackageKind | 'failed';

export function PluginsPage({
  services,
  active = true,
}: {
  services: ProductServices;
  active?: boolean;
}) {
  const [installKind, setInstallKind] = useState<PackageKind>('server');
  const [installOpen, setInstallOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [listing, setListing] = useState<Listing>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<PluginConfigurationTarget | null>(null);
  const action = useAction();
  const defaults = useSnapshot(services.pluginDefaults);
  const defaultFailures = defaults.results.filter((entry) => entry.status === 'failed');
  const defaultEnabled = defaults.results.filter((entry) => entry.status !== 'failed');
  const server = useSnapshot(services.runtime.serverPlugins);
  const serverPackages = useMemo(
    () => ({
      snapshot: () => services.runtime.pluginPackages.snapshot('server'),
      subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) =>
        services.runtime.pluginPackages.subscribe('server', listener),
    }),
    [services],
  );
  const browserPackages = useMemo(
    () => ({
      snapshot: () => services.runtime.pluginPackages.snapshot('browser'),
      subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) =>
        services.runtime.pluginPackages.subscribe('browser', listener),
    }),
    [services],
  );
  const serverDirectory = useSnapshot(serverPackages);
  const browserDirectory = useSnapshot(browserPackages);
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
  useEffect(() => {
    if (!active) {
      setConfiguration(null);
      setExtensionCall(null);
      setInstallOpen(false);
      action.cancel();
    }
  }, [active]);
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
      services.runtime.pluginPackages.refresh('server', signal),
      services.runtime.pluginPackages.refresh('browser', signal),
      services.runtime.serverPlugins.refresh(signal),
    ]);
    if (!signal.aborted) syncExtensions();
  }
  useEffect(() => {
    if (defaults.phase === 'running') return;
    void action.run(refresh, { quiet: true });
  }, [services, defaults.phase]);
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
  async function copyDefaultLog(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      services.messages.success('日志 ID 已复制');
    } catch {
      services.messages.warning('复制失败，请手动选择日志 ID');
    }
  }
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

  // 清单合并服务器与浏览器两侧，按"种类:包 ID"定位，避免同名包互相覆盖。
  const rows = [
    ...(serverDirectory.result?.data ?? []).map((pkg) => ({
      kind: 'server' as const,
      id: pkg.id,
      version: pkg.version,
      runtime: pkg.runtime,
      apiVersion: pkg.api_version ?? null,
      entryPath: pkg.entry_path,
      state:
        server.result?.data.find((entry) => entry.id === pkg.id)?.state ??
        ('unknown' as string),
      cleanupFailed: Boolean(
        server.result?.data.find((entry) => entry.id === pkg.id)?.cleanup_failed,
      ),
      generation: null as string | null,
    })),
    ...(browserDirectory.result?.data ?? []).map((pkg) => {
      const running = browserRunning.find((entry) => entry.id === pkg.id);
      return {
        kind: 'browser' as const,
        id: pkg.id,
        version: pkg.version,
        runtime: pkg.runtime,
        apiVersion: pkg.api_version ?? null,
        entryPath: pkg.entry_path,
        state: running?.state ?? 'missing',
        cleanupFailed: false,
        generation: running ? String(running.generation) : null,
      };
    }),
  ];
  const failedIds = new Set(defaultFailures.map((entry) => entry.id));
  const visible = rows.filter((row) => {
    if (listing === 'all') return true;
    if (listing === 'failed') return failedIds.has(row.id);
    return row.kind === listing;
  });
  const selected =
    rows.find((row) => `${row.kind}:${row.id}` === selectedKey) ?? visible[0] ?? null;
  const contributions = (pluginId: string) => ({
    components: catalog.components.filter((entry) => entry.pluginId === pluginId),
    modules: catalog.modules.filter((entry) => entry.pluginId === pluginId),
    commands: catalog.commands.filter((entry) => entry.pluginId === pluginId),
    services: catalog.services.filter((entry) => entry.pluginId === pluginId),
  });
  const contributionTotal = (pluginId: string) => {
    const owned = contributions(pluginId);
    return owned.components.length + owned.modules.length + owned.commands.length + owned.services.length;
  };
  const stateText = (row: (typeof rows)[number]) => {
    if (row.cleanupFailed) return '清理未确认';
    if (row.state === 'loaded') return `已加载${row.generation ? ` · gen ${row.generation}` : ''}`;
    if (row.state === 'draining') return '正在排空';
    if (row.state === 'missing') return '未启用';
    return '已卸载';
  };
  return (
    <div className="product-page plugins-page" data-product-page="plugins">
      <header className="plugin-topline">
        <div className="plugin-topline-main">
          <h1>插件</h1>
          <span className="plugin-topline-meta mono">
            {rows.length} 已安装 · {catalog.components.length + catalog.modules.length + catalog.commands.length + catalog.services.length} 项贡献
            {defaultFailures.length ? ` · ${defaultFailures.length} 失败` : ''}
          </span>
        </div>
        <div className="plugin-topline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={action.pending || defaults.phase === 'running'}
            onClick={() => void action.run(refresh)}
          >
            <RefreshCw aria-hidden="true" />刷新目录
          </Button>
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <PackagePlus aria-hidden="true" />安装插件
          </Button>
        </div>
      </header>
      <div className="plugin-filters" role="group" aria-label="插件筛选">
        {(
          [
            ['all', '全部'],
            ['server', '服务器'],
            ['browser', '浏览器'],
            ['failed', '失败'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="dock-filter"
            aria-pressed={listing === id}
            onClick={() => setListing(id)}
          >
            {label}
            {id === 'failed' && defaultFailures.length > 0 ? ` ${defaultFailures.length}` : ''}
          </button>
        ))}
      </div>
      <div className="plugin-split">
        <div className="plugin-list" aria-label="插件清单">
          {visible.length === 0 ? (
            <EmptyState
              title={rows.length ? '没有匹配的插件' : '还没有部署插件包'}
              description={rows.length ? '切换筛选条件。' : '提交 ZIP 或 TGZ 插件包后按需启用。'}
            />
          ) : (
            visible.map((row) => {
              const key = `${row.kind}:${row.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="plugin-list-row"
                  data-current={selected ? `${selected.kind}:${selected.id}` === key : false}
                  data-failed={failedIds.has(row.id) ? 'true' : undefined}
                  onClick={() => setSelectedKey(key)}
                >
                  <span className="plugin-list-copy">
                    <strong>{row.id}</strong>
                    <small>
                      {row.kind === 'server' ? '服务器' : '浏览器'} · {row.version}
                      {row.apiVersion ? ` · api ${row.apiVersion}` : ''}
                    </small>
                  </span>
                  <span className="plugin-list-side">
                    <em data-state={row.state}>{stateText(row)}</em>
                    <i className="mono">{contributionTotal(row.id)}</i>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="plugin-detail">
          <ActionFeedback {...action} />
          {!selected ? (
            <EmptyState title="选择一个插件" description="左侧清单展示已部署的插件包与贡献数量。" />
          ) : (
            <>
              <header className="plugin-detail-head">
                <h2>{selected.id}</h2>
                <span className="mono">
                  {selected.kind === 'server' ? '服务器插件' : '浏览器插件'} · v{selected.version}
                  {selected.apiVersion ? ` · apiVersion ${selected.apiVersion}` : ' · API 版本未声明'}
                  {selected.generation ? ` · gen ${selected.generation}` : ''}
                </span>
              </header>
              <p className={selected.cleanupFailed ? 'plugin-detail-error' : 'plugin-detail-state'}>
                {selected.cleanupFailed
                  ? '该代次的外部资源清理未确认，管理操作已暂停。'
                  : selected.state === 'draining'
                    ? '正在排空旧代次，稍后再启用。'
                    : selected.state === 'loaded'
                      ? '运行中。贡献已注册到宿主，可单独挂载或撤销。'
                      : '已部署但未启用；启用后才会注册贡献。'}
              </p>
              <dl className="plugin-facts">
                <div>
                  <dt>运行方式</dt>
                  <dd className="mono">{selected.runtime}</dd>
                </div>
                <div>
                  <dt>入口</dt>
                  <dd className="mono">{selected.entryPath}</dd>
                </div>
                <div>
                  <dt>生命周期</dt>
                  <dd className="mono">
                    {selected.state === 'loaded' || selected.state === 'missing'
                      ? '安装 → 注册'
                      : '安装 → 注册 → 卸载'}
                    {selected.generation ? ` → 挂载 gen ${selected.generation}` : ''}
                  </dd>
                </div>
              </dl>
              <section className="plugin-contrib" aria-label="插件贡献">
                <span className="plugin-section-label">
                  贡献 · {contributionTotal(selected.id)} 项
                </span>
                {contributionTotal(selected.id) === 0 ? (
                  <p className="plugin-contrib-empty">
                    {selected.state === 'loaded' || selected.state === 'missing'
                      ? '这个插件没有登记组件、模块、命令或服务。'
                      : '启用后才登记贡献。'}
                  </p>
                ) : (
                  <ul className="plugin-contrib-list">
                    {contributions(selected.id).components.map((entry) => (
                      <li key={`c-${entry.id}`}>
                        <span className="plugin-contrib-kind">组件</span>
                        <span className="plugin-contrib-name">
                          {entry.title}
                          <small className="mono">{entry.slot}</small>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.pending || entry.slot !== 'workshop.extensions'}
                          onClick={() => toggleExtension(entry.id, false)}
                        >
                          {mounted.has(entry.id) ? '撤销挂载' : '挂载'}
                        </Button>
                      </li>
                    ))}
                    {contributions(selected.id).modules.map((entry) => (
                      <li key={`m-${entry.id}`}>
                        <span className="plugin-contrib-kind">模块</span>
                        <span className="plugin-contrib-name">
                          {entry.title}
                          <small className="mono">#{entry.route}</small>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.pending}
                          onClick={() => toggleExtension(entry.id, true)}
                        >
                          {mounted.has(entry.id) ? '关闭' : '打开'}
                        </Button>
                      </li>
                    ))}
                    {contributions(selected.id).commands.map((entry) => (
                      <li key={`d-${entry.id}`}>
                        <span className="plugin-contrib-kind">命令</span>
                        <span className="plugin-contrib-name">{entry.title}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.pending}
                          onClick={() => {
                            setExtensionInput('{}');
                            setExtensionCall({ id: entry.id, title: entry.title, version: null });
                          }}
                        >
                          执行
                        </Button>
                      </li>
                    ))}
                    {contributions(selected.id).services.map((entry) => (
                      <li key={`s-${entry.id}`}>
                        <span className="plugin-contrib-kind">服务</span>
                        <span className="plugin-contrib-name">
                          {entry.id}
                          <small className="mono">{entry.version}</small>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.pending}
                          onClick={() => {
                            setExtensionInput('{}');
                            setExtensionCall({
                              id: entry.id,
                              title: entry.id,
                              version: entry.version,
                            });
                          }}
                        >
                          调用
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <div className="plugin-detail-actions">
                <Button
                  size="sm"
                  variant={selected.state === 'loaded' ? 'outline' : 'default'}
                  disabled={
                    action.pending ||
                    defaults.phase === 'running' ||
                    selected.cleanupFailed ||
                    selected.state === 'draining'
                  }
                  onClick={() => {
                    void manage((signal) =>
                      selected.state === 'loaded'
                        ? services.runtime.pluginPackages.disable(selected.kind, selected.id, signal)
                        : services.runtime.pluginPackages.enable(selected.kind, selected.id, signal),
                    );
                  }}
                >
                  {selected.state === 'loaded' ? '停用' : '启用'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.pending}
                  onClick={() => setConfiguration({ kind: selected.kind, id: selected.id })}
                >
                  <Settings2 aria-hidden="true" />配置
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.pending || selected.state === 'loaded' || selected.cleanupFailed}
                  onClick={() => {
                    void manage((signal) =>
                      services.runtime.pluginPackages.remove(selected.kind, selected.id, signal),
                    );
                  }}
                >
                  <Trash2 aria-hidden="true" />删除
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      <footer className="plugin-foot">
        <details className="plugin-foot-block" data-plugin-defaults={defaults.phase} data-phase={defaults.phase}>
          <summary>
            启动核对
            <span>
              {defaults.phase === 'running'
                ? '核对中'
                : `${defaultEnabled.length} 项通过${defaultFailures.length ? ` · ${defaultFailures.length} 项失败` : ''}`}
            </span>
          </summary>
          <p className="plugin-foot-note">
            启动时默认启用已安装插件；手动停用后保持停用。
            {defaults.phase === 'completed'
              ? ` 本轮 ${defaultEnabled.length} 项通过${defaultFailures.length ? `，${defaultFailures.length} 项失败` : ''}。`
              : defaults.phase === 'cancelled'
                ? ' 本轮等待已取消，可重新执行。'
                : ''}
          </p>
          <div className="plugin-foot-actions">
            {defaultFailures.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={action.pending || defaults.phase === 'running'}
                onClick={() => runDefaults(services.pluginDefaults.retryFailures)}
              >
                重试失败项
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending || defaults.phase === 'running'}
              onClick={() => runDefaults(services.pluginDefaults.restart)}
            >
              重新核对并启用
            </Button>
          </div>
          {defaultFailures.map((entry) => (
            <div
              className="plugin-fail-row"
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
        <details className="plugin-foot-block">
          <summary>主题</summary>
          <Select
            value={themes.selected?.id ?? 'base'}
            onValueChange={(value) => {
              void action.run(async () =>
                services.runtime.themes.select(value === 'base' ? null : value),
              );
            }}
          >
            <SelectTrigger aria-label="选择主题" size="sm">
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
        </details>
      </footer>
      <Dialog open={active && installOpen} onOpenChange={setInstallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>安装插件</DialogTitle>
            <DialogDescription>部署后需启用。插件按可信代码运行。</DialogDescription>
          </DialogHeader>
          <div className="form-field">
            <Label htmlFor="plugin-kind">部署到</Label>
            <Select
              value={installKind}
              onValueChange={(value) => {
                if (value === 'server' || value === 'browser') setInstallKind(value);
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
          <div className="form-field">
            <Label htmlFor="plugin-file">插件包 · ZIP / TGZ</Label>
            <Input
              id="plugin-file"
              type="file"
              accept=".zip,.tgz,.tar.gz"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={!file || action.pending}
              onClick={() => {
                if (!file) return;
                const mediaType = file.name.toLowerCase().endsWith('.zip')
                  ? 'application/zip'
                  : 'application/gzip';
                void manage((signal) =>
                  services.runtime.pluginPackages.upload(installKind, file, mediaType, signal),
                ).then(() => setInstallOpen(false));
              }}
            >
              提交插件包
            </Button>
          </DialogFooter>
          <ActionFeedback {...action} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={active && extensionCall !== null}
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
      {active && configuration && (
        <PluginConfigurationDialog
          open
          title={configuration.id}
          onClose={() => setConfiguration(null)}
          load={(signal) => services.pluginConfigurations.get(configuration, signal)}
          save={(revision, values, signal) =>
            services.pluginConfigurations.save(configuration, revision, values, signal)
          }
          reset={(revision, signal) =>
            services.pluginConfigurations.reset(configuration, revision, signal)
          }
          apply={(revision, signal) =>
            services.pluginConfigurations.apply(configuration, revision, signal)
          }
          onApplied={syncExtensions}
        />
      )}
    </div>
  );
}
