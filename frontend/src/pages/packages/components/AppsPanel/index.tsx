import { useEffect, useId, useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import { Input } from '../../../../components/Input/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/Select/index.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../../components/Table/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/Dialog/index.tsx';
import { prepareApksInstallInput } from '../../../../features/package-analysis/index.ts';
import type { DeviceRef } from '../../../../plugin-sdk/index.ts';
import { EmptyState, Field, JsonResult } from '../../../../components/index.ts';
import { ActionFeedback } from '../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import {
  appIdentifierInput,
  capabilityGate,
  decodeAppList,
  decodeDeviceBusinessResult,
  deviceAction,
  deviceKey,
  executeDeviceTask,
  sameDevice,
} from '../../../../features/device-apps/index.ts';
import type {
  AppCapability,
  AppList,
  DeviceBusinessResult,
} from '../../../../features/device-apps/index.ts';

type RowAction = 'app.start' | 'app.stop' | 'app.uninstall' | 'app.detail' | 'app.reset';
const actionNames: Readonly<Record<RowAction, string>> = {
  'app.start': '启动',
  'app.stop': '停止',
  'app.uninstall': '卸载',
  'app.detail': '详情',
  'app.reset': '清除数据',
};
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

export function AppsPage({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const reference = snapshot.selection;
  const key = deviceKey(reference);
  const operations = catalog.pending ? [] : (catalog.result?.data ?? []);
  const [list, setList] = useState<{ key: string; data: AppList } | null>(null);
  const [report, setReport] = useState<AppReport | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [ability, setAbility] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [filename, setFilename] = useState('');
  const [format, setFormat] = useState<'apk' | 'apks' | 'hap'>('apk');
  const [modules, setModules] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
  const shownPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(shownPage * 30, shownPage * 30 + 30);
  useEffect(() => {
    reading.cancel();
    action.cancel();
    upload.cancel();
    setList(null);
    setReport(null);
    setConfirmation(null);
    setPage(0);
    setAbility('');
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
        setPage(0);
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
    <div className="workspace-section" data-product-section="apps">
      <div className="section-heading">
        <div>
          <h2>设备应用</h2>
          <p className="muted">
            {snapshot.selected
              ? `${snapshot.selected.model ?? '设备'} · ${reference?.localId} · ${reference?.providerId} / ${reference?.generation}`
              : '在设备页选择当前提供者代次的在线设备。'}
          </p>
        </div>
        <Button
          disabled={!listing.capability || busy}
          title={listing.reason ?? undefined}
          onClick={refresh}
        >
          读取应用列表
        </Button>
      </div>
      {listing.reason && <p className="capability-notice">{listing.reason}</p>}
      <ActionFeedback {...reading} />
      {currentList ? (
        <>
          {currentList.unrecognized.length > 0 ? (
            <EmptyState
              title="应用列表文本未识别"
              description="返回文本包含未知行，尚未生成可操作应用清单。请展开原始输出供排查。"
            />
          ) : (
            <>
              <Field
                label="筛选应用标识"
                value={filter}
                onChange={(value) => {
                  setFilter(value);
                  setPage(0);
                }}
                placeholder="输入实际包名或 Bundle 标识"
              />
              {'ability' in (start.fields ?? {}) && (
                <Field
                  label="启动 Ability（可选）"
                  value={ability}
                  onChange={setAbility}
                  hint="留空由提供者按实际应用详情推导。"
                />
              )}
              {rows.length ? (
                <div className="table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>应用标识</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((identifier) => (
                        <TableRow key={identifier}>
                          <TableCell className="break-all">{identifier}</TableCell>
                          <TableCell>
                            <div className="page-actions">
                              {(
                                [
                                  'app.start',
                                  'app.stop',
                                  'app.uninstall',
                                  'app.detail',
                                  'app.reset',
                                ] as const
                              ).map((id) => {
                                const supported = gate(id);
                                if (
                                  (id === 'app.detail' || id === 'app.reset') &&
                                  !supported.capability
                                )
                                  return null;
                                return (
                                  <Button
                                    key={id}
                                    size="sm"
                                    variant={
                                      id === 'app.uninstall' || id === 'app.reset'
                                        ? 'ghost'
                                        : 'outline'
                                    }
                                    disabled={!supported.capability || busy}
                                    title={supported.reason ?? undefined}
                                    aria-label={`${actionNames[id]} ${identifier}`}
                                    onClick={() => {
                                      const target = reference;
                                      if (!target) return;
                                      if (id === 'app.uninstall' || id === 'app.reset')
                                        setConfirmation({
                                          reference: target,
                                          identifier,
                                          capability: id,
                                        });
                                      else runRow(id, identifier, target);
                                    }}
                                  >
                                    {actionNames[id]}
                                  </Button>
                                );
                              })}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <EmptyState
                  title={currentList.identifiers.length ? '没有匹配的应用' : '设备返回空应用列表'}
                />
              )}
              <div className="page-actions">
                <span className="muted">
                  {filtered.length} 个标识 · 第 {shownPage + 1} / {pageCount} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shownPage === 0}
                  onClick={() => setPage(shownPage - 1)}
                >
                  上一页应用
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shownPage + 1 >= pageCount}
                  onClick={() => setPage(shownPage + 1)}
                >
                  下一页应用
                </Button>
              </div>
            </>
          )}
          <details>
            <summary>应用列表原始输出</summary>
            <pre className="code-output">{currentList.output || '（空文本）'}</pre>
          </details>
        </>
      ) : (
        <EmptyState
          title="尚未读取当前设备的应用"
          description="列表只显示提供者返回的实际应用标识，不补造名称、版本或运行状态。"
        />
      )}
      <h3>安装到所选设备</h3>
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
      <p className="muted">先上传为服务器产物，再提交安装。取消等待不会撤销已经执行的设备安装。</p>
      <ActionFeedback {...upload} />
      {filename && <p className="file-name">已上传：{filename}</p>}
      <fieldset disabled={busy} className="form-grid">
        <Field label="设备安装产物 ID" value={artifactId} onChange={setArtifactId} />
        <div className="form-field">
          <Label>安装包格式</Label>
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
        {format === 'apks' && (
          <Field
            label="安装 APKS 模块（可选）"
            value={modules}
            onChange={setModules}
            hint="逗号分隔；模块须唯一，ALL 只能单选。留空使用提供者默认模块。"
          />
        )}
      </fieldset>
      {install.reason && <p className="capability-notice">{install.reason}</p>}
      <Button disabled={!artifactId.trim() || !install.capability || busy} onClick={runInstall}>
        安装到当前设备
      </Button>
      <ActionFeedback {...action} />
      {currentReport && (
        <div className="result-row">
          <h3>
            {currentReport.capability === 'app.install' ||
            currentReport.capability === 'app.install_apks'
              ? '安装任务完成'
              : `${actionNames[currentReport.capability]}任务完成`}{' '}
            · {currentReport.identifier}
          </h3>
          <p className="muted">服务器任务已成功终结；设备后续状态可重新读取确认。</p>
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
