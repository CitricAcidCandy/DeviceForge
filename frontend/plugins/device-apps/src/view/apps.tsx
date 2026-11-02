import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, RefreshCw, Search, X } from 'lucide-react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, EmptyState, Field, JsonResult } from './ui.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './dropdown-menu.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@deviceforge/business-kit/dialog';
import { prepareApksInstallInput } from '../model/package-analysis/index.ts';
import type { DeviceRef } from '@deviceforge/plugin-sdk';
import { ActionFeedback, useAction, useSnapshot } from '@deviceforge/business-kit/react';
import type { DeviceAppsServices } from '../services.ts';
import type { Confirmation, AppReport } from '../drafts.ts';
import { useDraft } from './draft-state.ts';
import { appIdentifierInput, capabilityGate, decodeAppList, decodeDeviceBusinessResult, deviceAction, deviceKey, executeDeviceTask, sameDevice } from '@deviceforge/business-kit/device';
import type { AppCapability } from '@deviceforge/business-kit/device';
import { ApiError } from '@deviceforge/business-kit/api';

type RowAction = 'app.start' | 'app.stop' | 'app.uninstall' | 'app.detail' | 'app.reset';
/** 行菜单的顺序：能做的在上面，破坏性的沉底并用分隔线隔开。 */
const rowActions: readonly { id: RowAction; label: string; destructive?: boolean }[] = [
  { id: 'app.start', label: '启动应用' },
  { id: 'app.stop', label: '停止应用' },
  { id: 'app.detail', label: '查看详情' },
  { id: 'app.reset', label: '清除数据', destructive: true },
  { id: 'app.uninstall', label: '卸载应用', destructive: true },
];
const actionNames: Readonly<Record<RowAction, string>> = {
  'app.start': '启动',
  'app.stop': '停止',
  'app.uninstall': '卸载',
  'app.detail': '详情',
  'app.reset': '清除数据',
};
/* 一次多渲染 60 行；比 30 条一页的翻页少一次点击，也不用重排滚动位置。 */
const PAGE_STEP = 60;
const FIRST_PAGE = 60;
/**
 * 设备应用：一行一个应用，操作收进行尾菜单。
 * 早先那版把五个按钮摊在表格单元格里，窄栏里每行被撑到 100px 高、一屏只看得到三四个应用；
 * 现在标识占满一行、按钮只剩一个，同样的高度能放下七八个。
 */
export function AppsPage({
  services,
  compact = false,
  active = true,
}: {
  services: DeviceAppsServices;
  /** 收进设备工作台右栏：不重复设备身份，也不把读取按钮做成主按钮。 */
  compact?: boolean;
  active?: boolean;
}) {
  const snapshot = useSnapshot(services.devices);
  const catalog = useSnapshot(services.operations);
  const reference = snapshot.selection;
  const key = deviceKey(reference);
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const [list, setList] = useDraft(services.drafts.apps.list);
  const [report, setReport] = useDraft(services.drafts.apps.report);
  const [filter, setFilter] = useDraft(services.drafts.apps.filter);
  const [visible, setVisible] = useDraft(services.drafts.apps.visible);
  const [ability, setAbility] = useDraft(services.drafts.apps.ability);
  const [artifactId, setArtifactId] = useDraft(services.drafts.apps.artifactId);
  const [filename, setFilename] = useDraft(services.drafts.apps.filename);
  const [format, setFormat] = useDraft(services.drafts.apps.format);
  const [modules, setModules] = useDraft(services.drafts.apps.modules);
  const [installOpen, setInstallOpen] = useDraft(services.drafts.apps.installOpen);
  const [confirmation, setConfirmation] = useDraft(services.drafts.apps.confirmation);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const reading = useAction();
  const action = useAction();
  const upload = useAction();
  const uploadId = useId();
  const busy = reading.pending || action.pending || upload.pending;
  const gate = (id: AppCapability) => capabilityGate(snapshot, operations, id);
  const listing = gate('packages');
  const start = gate('app.start');
  const installId = format === 'apks' ? 'app.install_apks' : 'app.install';
  const install = gate(installId);
  const currentList = list?.key === key ? list.data : null;
  const currentReport = report?.key === key ? report : null;
  const filtered =
    currentList?.identifiers.filter((identifier) =>
      identifier.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  const rows = filtered.slice(0, visible);
  const rest = filtered.length - rows.length;
  useEffect(() => { if (!active) setRowMenu(null); }, [active]);
  const previousKey = useRef(key);
  useEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key;
    reading.cancel();
    action.cancel();
    upload.cancel();
    setList(null);
    setReport(null);
    setConfirmation(null);
    setVisible(FIRST_PAGE);
    setAbility('');
    setInstallOpen(true);
  }, [key, reading.cancel, action.cancel, upload.cancel]);
  const activeReference = (target: DeviceRef) =>
    sameDevice(services.devices.snapshot().selection, target);
  const refresh = () => {
    const target = reference;
    if (!target || (catalog.result && !listing.capability)) return;
    void reading.run(async (signal) => {
      const currentCatalog = await services.ensureOperations(signal);
      const selectedGate = capabilityGate(services.devices.snapshot(), currentCatalog.data,
        'packages', null, target);
      if (!selectedGate.capability)
        throw new ApiError('protocol', 'device_action_unavailable',
          selectedGate.reason || '当前设备不支持应用列表');
      const response = await executeDeviceTask(
        services,
        'packages',
        deviceAction(target, selectedGate, {}),
        signal,
        decodeAppList,
      );
      if (!signal.aborted && activeReference(target)) {
        setList({ key: deviceKey(target), data: response.data });
        setVisible(FIRST_PAGE);
        /* 列表读出来就把安装区收起来：这时候用户要看的是应用，不是上传表单。 */
        setInstallOpen(false);
      }
      return response;
    });
  };
  const runRow = (id: RowAction, identifier: string, target: DeviceRef) => {
    if (!activeReference(target)) return;
    const currentGate = capabilityGate(
      services.devices.snapshot(),
      operations,
      id,
      null,
      target,
    );
    if (!currentGate.capability) return;
    void action.run(async (signal) => {
      const response = await executeDeviceTask(
        services,
        id,
        deviceAction(
          target,
          currentGate,
          appIdentifierInput(currentGate, identifier, id === 'app.start' ? ability : ''),
        ),
        signal,
        decodeDeviceBusinessResult,
      );
      if (!signal.aborted && activeReference(target)) {
        setReport({ key: deviceKey(target), identifier, capability: id, data: response.data });
        if (id === 'app.uninstall') setList(null);
      }
      return response;
    });
  };
  const accept = (file: File) => {
    const suffix = file.name.split('.').at(-1)?.toLowerCase();
    if (suffix !== 'apk' && suffix !== 'apks' && suffix !== 'hap') return;
    const target = reference;
    void upload.run(async (signal) => {
      const response = await services.artifacts.upload(file.name, file, signal);
      if (!signal.aborted && sameDevice(services.devices.snapshot().selection, target)) {
        setArtifactId(response.data.id);
        setFilename(response.data.filename);
        setFormat(suffix);
      }
      return response;
    });
  };
  const runInstall = () => {
    const target = reference;
    const selectedGate = install;
    const selectedFormat = format;
    if (!target || !selectedGate.capability) return;
    void action.run(async (signal) => {
      const input =
        selectedFormat === 'apks'
          ? prepareApksInstallInput({
              artifact_id: artifactId,
              ...(modules.trim() ? { modules: modules.split(',').map((item) => item.trim()) } : {}),
            })
          : { artifact_id: artifactId };
      const response = await executeDeviceTask(
        services,
        installId,
        deviceAction(target, selectedGate, input),
        signal,
        decodeDeviceBusinessResult,
      );
      if (!signal.aborted && activeReference(target)) {
        setReport({
          key: deviceKey(target),
          identifier: filename || artifactId,
          capability: installId,
          data: response.data,
        });
        setList(null);
      }
      return response;
    });
  };
  const confirmationGate = confirmation
    ? capabilityGate(snapshot, operations, confirmation.capability, null, confirmation.reference)
    : null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 pt-3 [&_label]:text-xs [&_label]:font-normal [&_label]:text-[var(--text-faint)] [&_.empty-state]:my-0.5 [&_.empty-state]:px-0 [&_.empty-state]:py-3 [&_.empty-state_h3]:mb-1 [&_.empty-state_h3]:text-sm [&_.empty-state_p]:text-xs [&_.empty-state_p]:leading-[1.6]" data-compact={compact ? 'true' : undefined} data-product-section="apps">
      {/* ── 工具行：搜索框吃满宽度，读取退成一个图标 ── */}
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex h-8 min-w-0 flex-auto items-center gap-[7px] rounded-[7px] border border-[var(--border)] bg-[var(--surface-card)] px-[9px] text-[var(--text-faint)] focus-within:border-[var(--primary)] focus-within:ring-3 focus-within:ring-[color-mix(in_srgb,var(--primary)_16%,transparent)] [&>svg]:size-3.5 [&>svg]:shrink-0">
          <Search aria-hidden="true" />
          <input
            className="h-full min-w-0 flex-auto border-0 bg-transparent text-[13px] text-[var(--text-strong)] outline-none placeholder:text-[var(--text-ghost)]"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setVisible(FIRST_PAGE);
            }}
            placeholder={
              currentList ? `在 ${currentList.identifiers.length} 个标识里筛选` : '筛选应用标识'
            }
            aria-label="筛选应用标识"
            type="text"
            spellCheck={false}
          />
          {filter && (
            <button
              type="button"
              className="inline-flex size-[18px] shrink-0 items-center justify-center rounded border-0 bg-[var(--surface-sunken)] p-0 text-[var(--text-faint)] [&>svg]:size-[11px]"
              aria-label="清除筛选"
              onClick={() => {
                setFilter('');
                setVisible(FIRST_PAGE);
              }}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface-card)] p-0 text-[var(--text-muted)] enabled:hover:border-[var(--hairline-strong)] enabled:hover:text-[var(--text-strong)] disabled:cursor-not-allowed disabled:text-[var(--text-ghost)] [&>svg]:size-[15px] [&>[data-spin=true]]:animate-[spin_1.1s_linear_infinite]"
          disabled={!reference || (catalog.result !== null && !listing.capability) || busy}
          title={listing.reason ?? (currentList ? '重新读取应用列表' : '读取应用列表')}
          aria-label={currentList ? '重新读取应用列表' : '读取应用列表'}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" data-spin={reading.pending ? 'true' : undefined} />
        </button>
      </div>
      {listing.reason && <p className="m-0 text-[13px] leading-[1.6] text-[var(--text-faint)]">{listing.reason}</p>}
      {'ability' in (start.fields ?? {}) && (
        <details className="border-t border-[var(--hairline)] pt-2 [&>summary]:flex [&>summary]:min-h-6 [&>summary]:list-none [&>summary]:items-center [&>summary]:justify-between [&>summary]:gap-2 [&>summary]:py-0.5 [&>summary]:text-xs [&>summary]:font-medium [&>summary]:text-[var(--text-muted)] [&>summary::-webkit-details-marker]:hidden [&>summary]:after:text-[var(--text-ghost)] [&>summary]:after:transition-transform [&>summary]:after:duration-[120ms] [&>summary]:after:content-['›'] [&[open]>summary]:mb-2 [&[open]>summary]:after:rotate-90 [&>*+*]:mt-2">
          <summary>启动 Ability（可选）</summary>
          <Field
            label="Ability"
            value={ability}
            onChange={setAbility}
            hint="留空由提供者按实际应用详情推导。"
            placeholder="留空自动推导"
          />
        </details>
      )}
      <ActionFeedback {...reading} />
      {currentList ? (
        currentList.unrecognized.length > 0 ? (
          <EmptyState
            title="应用列表文本未识别"
            description="返回文本包含未知行，尚未生成可操作应用清单。请展开原始输出供排查。"
          />
        ) : rows.length ? (
          <>
            <ul className="m-0 list-none border-t border-[var(--hairline)] p-0" aria-label="设备应用标识">
              {rows.map((identifier) => (
                <li className="flex items-center gap-1.5 border-b border-[var(--hairline)] py-[5px] pl-0.5 hover:bg-[color-mix(in_srgb,var(--surface-hover)_62%,transparent)]" key={identifier}>
                  <span className="line-clamp-2 min-w-0 flex-auto text-[13px] leading-normal [overflow-wrap:anywhere] text-[var(--text-body)] font-mono" title={identifier}>
                    {identifier}
                  </span>
                  <DropdownMenu open={active && rowMenu === identifier}
                    onOpenChange={(open) => setRowMenu(open ? identifier : null)}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[var(--text-ghost)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-strong)] data-[state=open]:bg-[var(--surface-hover)] data-[state=open]:text-[var(--text-strong)] [&>svg]:size-[15px]"
                        aria-label={`${identifier} 的操作`}
                        aria-disabled={busy ? 'true' : undefined}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[172px] [&_[data-slot=dropdown-menu-item]]:text-[13px]">
                      <DropdownMenuLabel className="max-w-[260px] truncate px-1.5 py-[3px] text-xs text-[var(--text-ghost)] font-mono">
                        {identifier}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {rowActions.map((item) => {
                        const supported = gate(item.id);
                        /* 详情 / 清除数据在提供者不支持时干脆不出现：留着只会是五个灰条。 */
                        if (
                          (item.id === 'app.detail' || item.id === 'app.reset') &&
                          !supported.capability
                        )
                          return null;
                        return (
                          <DropdownMenuItem
                            key={item.id}
                            variant={item.destructive ? 'destructive' : 'default'}
                            disabled={!supported.capability || busy}
                            title={supported.reason ?? undefined}
                            onSelect={() => {
                              const target = reference;
                              if (!target) return;
                              if (item.id === 'app.uninstall' || item.id === 'app.reset') {
                                setConfirmation({
                                  reference: target,
                                  identifier,
                                  capability: item.id,
                                });
                              } else {
                                runRow(item.id, identifier, target);
                              }
                            }}
                          >
                            {item.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
            <div className="flex min-h-6 items-center justify-between gap-2">
              <span className="font-mono text-[13px] text-[var(--text-faint)]">
                {filtered.length === currentList.identifiers.length
                  ? `${filtered.length} 个应用`
                  : `${filtered.length} / ${currentList.identifiers.length} 个应用`}
              </span>
              {rest > 0 && (
                <button
                  type="button"
                  className="rounded-[5px] border-0 bg-transparent px-2 py-[3px] text-[13px] font-medium text-[var(--primary)] hover:bg-[var(--accent)]"
                  onClick={() => setVisible(visible + PAGE_STEP)}
                >
                  再显示 {Math.min(PAGE_STEP, rest)} 个
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="m-0 text-[13px] leading-[1.6] text-[var(--text-faint)]">
            {currentList.identifiers.length
              ? `没有匹配「${filter}」的应用。`
              : '设备返回了空应用列表。'}
          </p>
        )
      ) : (
        <EmptyState
          title="尚未读取当前设备的应用"
          description="列表只显示提供者返回的实际应用标识，不补造名称、版本或运行状态。"
        />
      )}
      {currentList && (
        <details className="border-t border-[var(--hairline)] pt-2 [&>summary]:flex [&>summary]:min-h-6 [&>summary]:list-none [&>summary]:items-center [&>summary]:justify-between [&>summary]:gap-2 [&>summary]:py-0.5 [&>summary]:text-xs [&>summary]:font-medium [&>summary]:text-[var(--text-muted)] [&>summary::-webkit-details-marker]:hidden [&>summary]:after:text-[var(--text-ghost)] [&>summary]:after:transition-transform [&>summary]:after:duration-[120ms] [&>summary]:after:content-['›'] [&[open]>summary]:mb-2 [&[open]>summary]:after:rotate-90 [&>*+*]:mt-2">
          <summary>原始输出</summary>
          <pre className="max-h-[180px] overflow-auto rounded-md bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{currentList.output || '（空文本）'}</pre>
        </details>
      )}

      {/* ── 安装：平时收起来，别把列表挤到看不见 ── */}
      <details
        className="border-t border-[var(--hairline)] pt-2 [&>summary]:flex [&>summary]:min-h-6 [&>summary]:list-none [&>summary]:items-center [&>summary]:justify-between [&>summary]:gap-2 [&>summary]:py-0.5 [&>summary]:text-xs [&>summary]:font-medium [&>summary]:text-[var(--text-muted)] [&>summary::-webkit-details-marker]:hidden [&>summary]:after:text-[var(--text-ghost)] [&>summary]:after:transition-transform [&>summary]:after:duration-[120ms] [&>summary]:after:content-['›'] [&[open]>summary]:mb-2 [&[open]>summary]:after:rotate-90 [&>*+*]:mt-2 "
        open={installOpen}
        onToggle={(event) => setInstallOpen(event.currentTarget.open)}
      >
        <summary>
          安装到当前设备
          {filename && <span className="min-w-0 flex-auto truncate text-right text-xs font-normal text-[var(--text-ghost)] font-mono">{filename}</span>}
        </summary>
        <Label htmlFor={uploadId}>上传 APK / APKS / HAP</Label>
        <Input
          id={uploadId}
          type="file"
          accept=".apk,.apks,.hap"
          disabled={busy || !reference}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) accept(file);
          }}
        />
        <ActionFeedback {...upload} />
        <p className="m-0 text-[13px] leading-[1.6] text-[var(--text-faint)]">先上传为服务器产物，再提交安装。取消等待不会撤销已经执行的设备安装。</p>
        <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_92px] items-start gap-2 border-0 p-0 [&_.form-item]:m-0 [&_.form-item]:grid-cols-1 [&_.form-item]:gap-1 [&_.form-item>label]:pt-0 [&_[data-slot=input]]:h-[30px] [&_[data-slot=input]]:min-h-[30px] [&_[data-slot=select-trigger]]:h-[30px] [&_[data-slot=select-trigger]]:min-h-[30px]">
          <Field
            label="产物 ID"
            value={artifactId}
            onChange={setArtifactId}
            placeholder="上传后自动填入"
          />
          <div className="grid min-w-0 gap-1.5">
            <Label>格式</Label>
            <Select
              value={format}
              onValueChange={(value) => {
                if (value === 'apk' || value === 'apks' || value === 'hap') setFormat(value);
              }}
            >
              <SelectTrigger aria-label="安装包格式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="apk">APK</SelectItem>
                <SelectItem value="apks">APKS</SelectItem>
                <SelectItem value="hap">HAP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </fieldset>
        {format === 'apks' && (
          <Field
            label="安装 APKS 模块（可选）"
            value={modules}
            onChange={setModules}
            hint="逗号分隔；模块须唯一，ALL 只能单选。"
          />
        )}
        {install.reason && <p className="m-0 text-[13px] leading-[1.6] text-[var(--text-faint)]">{install.reason}</p>}
        <Button
          className="h-8 w-full"
          disabled={!artifactId.trim() || !install.capability || busy}
          onClick={runInstall}
        >
          安装到当前设备
        </Button>
      </details>

      <ActionFeedback {...action} />
      {currentReport && (
        <div className="flex flex-col gap-1.5 border-t border-[var(--hairline)] pt-2.5 [&>h3]:m-0 [&>h3]:text-[13px] [&>h3]:font-semibold [&>h3]:text-[var(--text-strong)]">
          <h3>
            {currentReport.capability === 'app.install' ||
            currentReport.capability === 'app.install_apks'
              ? '安装任务完成'
              : `${actionNames[currentReport.capability]}任务完成`}
          </h3>
          <p className="m-0 text-xs [overflow-wrap:anywhere] text-[var(--text-faint)] font-mono">{currentReport.identifier}</p>
          <p className="m-0 text-[13px] leading-[1.6] text-[var(--text-faint)]">服务器任务已成功终结；设备后续状态可重新读取确认。</p>
          <JsonResult value={currentReport.data.result} />
        </div>
      )}
      <Dialog
        open={active && confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.capability === 'app.reset' ? '清除应用数据？' : '卸载设备应用？'}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.identifier} · 设备 {confirmation?.reference.localId} · 提供者{' '}
              {confirmation?.reference.providerId} / {confirmation?.reference.generation}。
              {confirmation?.capability === 'app.reset'
                ? '应用的数据将被清除。'
                : '应用及其设备数据可能被移除。'}
              取消等待不能证明操作未发生。
            </DialogDescription>
          </DialogHeader>
          {confirmationGate?.reason && (
            <p className="text-xs leading-relaxed text-[var(--text-faint)]">{confirmationGate.reason}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              保留应用
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !confirmationGate?.capability}
              onClick={() => {
                const target = confirmation;
                if (target) {
                  setConfirmation(null);
                  runRow(target.capability, target.identifier, target.reference);
                }
              }}
            >
              {confirmation?.capability === 'app.reset' ? '确认清除数据' : '确认卸载'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
