import { useEffect, useId, useState } from 'react';
import { MoreHorizontal, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '../../../../../components/Button/index.tsx';
import { Input } from '../../../../../components/Input/index.tsx';
import { Label } from '../../../../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/Select/index.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../../components/DropdownMenu/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../../components/Dialog/index.tsx';
import { prepareApksInstallInput } from '../../../../../features/package-analysis/index.ts';
import type { DeviceRef } from '../../../../../plugin-sdk/index.ts';
import { EmptyState, Field, JsonResult } from '../../../../../components/index.ts';
import { ActionFeedback } from '../../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../../app/product/services.ts';
import {
  appIdentifierInput,
  capabilityGate,
  decodeAppList,
  decodeDeviceBusinessResult,
  deviceAction,
  deviceKey,
  executeDeviceTask,
  sameDevice,
} from '../../../../../features/device-apps/index.ts';
import type {
  AppCapability,
  AppList,
  DeviceBusinessResult,
} from '../../../../../features/device-apps/index.ts';

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
interface Confirmation {
  readonly reference: DeviceRef;
  readonly identifier: string;
  readonly capability: 'app.uninstall' | 'app.reset';
}
interface AppReport {
  readonly key: string;
  readonly identifier: string;
  readonly capability: RowAction | 'app.install' | 'app.install_apks';
  readonly data: DeviceBusinessResult;
}

/**
 * 设备应用：一行一个应用，操作收进行尾菜单。
 * 早先那版把五个按钮摊在表格单元格里，窄栏里每行被撑到 100px 高、一屏只看得到三四个应用；
 * 现在标识占满一行、按钮只剩一个，同样的高度能放下七八个。
 */
export function AppsPage({
  services,
  compact = false,
}: {
  services: ProductServices;
  /** 收进设备工作台右栏：不重复设备身份，也不把读取按钮做成主按钮。 */
  compact?: boolean;
}) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const reference = snapshot.selection;
  const key = deviceKey(reference);
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const [list, setList] = useState<{ key: string; data: AppList } | null>(null);
  const [report, setReport] = useState<AppReport | null>(null);
  const [filter, setFilter] = useState('');
  const [visible, setVisible] = useState(FIRST_PAGE);
  const [ability, setAbility] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [filename, setFilename] = useState('');
  const [format, setFormat] = useState<'apk' | 'apks' | 'hap'>('apk');
  const [modules, setModules] = useState('');
  const [installOpen, setInstallOpen] = useState(true);  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
  useEffect(() => {
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
    sameDevice(services.runtime.devices.snapshot().selection, target);
  const refresh = () => {
    const target = reference;
    const selectedGate = listing;
    if (!target || !selectedGate.capability) return;
    void reading.run(async (signal) => {
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
      services.runtime.devices.snapshot(),
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
      const response = await services.artifactBrowser.upload(file.name, file, signal);
      if (!signal.aborted && sameDevice(services.runtime.devices.snapshot().selection, target)) {
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
    <div className="app-pane" data-compact={compact ? 'true' : undefined} data-product-section="apps">
      {/* ── 工具行：搜索框吃满宽度，读取退成一个图标 ── */}
      <div className="app-toolbar">
        <div className="app-search">
          <Search aria-hidden="true" />
          <input
            className="app-search-input"
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
              className="app-search-clear"
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
          className="app-icon-button"
          disabled={!listing.capability || busy}
          title={listing.reason ?? (currentList ? '重新读取应用列表' : '读取应用列表')}
          aria-label={currentList ? '重新读取应用列表' : '读取应用列表'}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" data-spin={reading.pending ? 'true' : undefined} />
        </button>
      </div>
      {listing.reason && <p className="app-hint">{listing.reason}</p>}
      {'ability' in (start.fields ?? {}) && (
        <details className="app-fold">
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
            <ul className="app-list" aria-label="设备应用标识">
              {rows.map((identifier) => (
                <li className="app-row" key={identifier}>
                  <span className="app-row-id mono" title={identifier}>
                    {identifier}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="app-row-menu"
                        aria-label={`${identifier} 的操作`}
                        aria-disabled={busy ? 'true' : undefined}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="app-menu">
                      <DropdownMenuLabel className="app-menu-id mono">
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
            <div className="app-list-foot">
              <span className="mono app-count">
                {filtered.length === currentList.identifiers.length
                  ? `${filtered.length} 个应用`
                  : `${filtered.length} / ${currentList.identifiers.length} 个应用`}
              </span>
              {rest > 0 && (
                <button
                  type="button"
                  className="app-more"
                  onClick={() => setVisible((value) => value + PAGE_STEP)}
                >
                  再显示 {Math.min(PAGE_STEP, rest)} 个
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="app-hint">
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
        <details className="app-fold">
          <summary>原始输出</summary>
          <pre className="code-output">{currentList.output || '（空文本）'}</pre>
        </details>
      )}

      {/* ── 安装：平时收起来，别把列表挤到看不见 ── */}
      <details
        className="app-fold app-install"
        open={installOpen}
        onToggle={(event) => setInstallOpen(event.currentTarget.open)}
      >
        <summary>
          安装到当前设备
          {filename && <span className="app-install-file mono">{filename}</span>}
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
        <p className="app-hint">先上传为服务器产物，再提交安装。取消等待不会撤销已经执行的设备安装。</p>
        <fieldset disabled={busy} className="app-install-fields">
          <Field
            label="产物 ID"
            value={artifactId}
            onChange={setArtifactId}
            placeholder="上传后自动填入"
          />
          <div className="form-field">
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
        {install.reason && <p className="app-hint">{install.reason}</p>}
        <Button
          className="app-install-run"
          disabled={!artifactId.trim() || !install.capability || busy}
          onClick={runInstall}
        >
          安装到当前设备
        </Button>
      </details>

      <ActionFeedback {...action} />
      {currentReport && (
        <div className="app-report">
          <h3>
            {currentReport.capability === 'app.install' ||
            currentReport.capability === 'app.install_apks'
              ? '安装任务完成'
              : `${actionNames[currentReport.capability]}任务完成`}
          </h3>
          <p className="app-report-target mono">{currentReport.identifier}</p>
          <p className="app-hint">服务器任务已成功终结；设备后续状态可重新读取确认。</p>
          <JsonResult value={currentReport.data.result} />
        </div>
      )}
      <Dialog
        open={confirmation !== null}
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
            <p className="capability-notice">{confirmationGate.reason}</p>
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
