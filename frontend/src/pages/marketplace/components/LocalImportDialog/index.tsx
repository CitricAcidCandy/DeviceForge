import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, DialogShell, FileDropzone, SelectField } from '../../../../components/index.ts';
import { errorLogId, useSnapshot } from '../../../../app/product/hooks.ts';
import { InstallationProgress } from '../InstallationProgress/index.tsx';
import type { ProductServices } from '../../../../app/product/services.ts';
import {
  localImportPorts,
  previewLocalImport,
  submitLocalImportWithResult,
} from '../../local-import/actions.ts';
import { parseLocalToolManifest, readImportJson } from '../../local-import/rules.ts';
import type {
  LocalImportKind,
  LocalImportPreview,
  LocalToolManifest,
  ImportedPluginDebugTarget,
} from '../../local-import/types.ts';
import { localImportDebugUnavailableReason, openImportedPluginDebugger } from '../../local-import/debugger.ts';
import type { PreparationExecutor, UploadSelection } from '../../upload-preparation/index.ts';
import { directorySelection } from '../../upload-preparation/directory.ts';

export function LocalImportDialog({
  open,
  onOpenChange,
  services,
  onImported,
  prepare,
}: {
  readonly open: boolean;
  readonly onOpenChange: (value: boolean) => void;
  readonly services: ProductServices;
  readonly onImported?: () => void;
  readonly prepare?: PreparationExecutor;
}) {
  const [kind, setKind] = useState<LocalImportKind>('plugin');
  const [file, setFile] = useState<File | null>(null);
  const [selection, setSelection] = useState<UploadSelection | null>(null);
  const folder = useRef<HTMLInputElement | null>(null);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<LocalToolManifest | null>(null);
  const [moduleId, setModuleId] = useState('');
  const [preview, setPreview] = useState<LocalImportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [logId, setLogId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [debugAfterImport, setDebugAfterImport] = useState(false);
  const [debugTarget, setDebugTarget] = useState<ImportedPluginDebugTarget | null>(null);
  const [debugRetry, setDebugRetry] = useState(false);
  const request = useRef<AbortController | null>(null);
  const debuggerSource = useMemo(() => ({
    snapshot: () => localImportDebugUnavailableReason(services),
    subscribe: (listener: (reason: string | null) => void) => services.runtime.extensions.subscribe(
      () => listener(localImportDebugUnavailableReason(services))),
  }), [services]);
  const debugUnavailable = useSnapshot(debuggerSource);
  const progressSource = useMemo(() => ({
    snapshot: services.runtime.pluginInstallations.progressSnapshot,
    subscribe: (listener: (value: ReturnType<typeof services.runtime.pluginInstallations.progressSnapshot>) => void) =>
      services.runtime.pluginInstallations.subscribeProgress(() => listener(services.runtime.pluginInstallations.progressSnapshot())),
  }), [services]);
  const installationProgress = useSnapshot(progressSource);
  useEffect(() => {
    if (!open) {
      request.current?.abort();
      request.current = null;
      return;
    }
    setKind('plugin');
    setFile(null);
    setSelection(null);
    setManifestFile(null);
    setManifest(null);
    setModuleId('');
    setPreview(null);
    setPending(false);
    setCompleted(false);
    setError('');
    setLogId(null);
    setFeedback('');
    setDebugAfterImport(false);
    setDebugTarget(null);
    setDebugRetry(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [open]);

  function invalidate() {
    setPreview(null);
    setError('');
    setLogId(null);
    setFeedback('');
    setCompleted(false);
    setDebugTarget(null);
    setDebugRetry(false);
  }
  function close(value: boolean) {
    if (!value) request.current?.abort();
    onOpenChange(value);
  }
  async function openDebugger(target: ImportedPluginDebugTarget, controller: AbortController) {
    try {
      await openImportedPluginDebugger(services, target, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setDebugRetry(false);
      close(false);
    } catch (reason) {
      if (request.current !== controller || controller.signal.aborted) return;
      setDebugRetry(true);
      setError(`插件已导入，但未能打开调试器：${reason instanceof Error ? reason.message : '请查看调试器状态后重试。'}`);
      setLogId(errorLogId(reason));
    }
  }
  async function run(action: 'manifest' | 'preview' | 'import' | 'debug') {
    if (request.current || pending || (completed && action !== 'debug')) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    setLogId(null);
    if (action !== 'debug') setFeedback('');
    try {
      if (action === 'debug') {
        if (!debugTarget) throw new Error('没有本次导入的插件目标，请到已安装列表选择插件。');
        await openDebugger(debugTarget, controller);
      } else if (action === 'manifest') {
        if (!manifestFile) throw new Error('请先选择工具清单 JSON');
        const result = parseLocalToolManifest(
          await readImportJson(manifestFile, controller.signal),
        );
        controller.signal.throwIfAborted();
        setManifest(result);
        setModuleId(result.modules[0]?.id ?? '');
        setPreview(null);
      } else if (action === 'preview') {
        if (!file) throw new Error('请先选择本地文件');
        const result = await previewLocalImport(
          localImportPorts(services),
          { kind, file, manifest, moduleId, ...(selection ? { selection } : {}) },
          controller.signal,
          prepare,
        );
        controller.signal.throwIfAborted();
        setPreview(result);
      } else {
        if (!preview) throw new Error('请先检查导入内容');
        const result = await submitLocalImportWithResult(
          localImportPorts(services),
          preview,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        setFeedback(result.message);
        setCompleted(true);
        setDebugTarget(result.debugTarget);
        onImported?.();
        if (debugAfterImport && result.debugTarget) await openDebugger(result.debugTarget, controller);
      }
    } catch (reason) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '本地导入失败');
        setLogId(errorLogId(reason));
        if (action === 'import') setPreview(null);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={close}
      title="从本地导入"
      size="lg"
      className="min-w-0 [&_code]:whitespace-normal [&_code]:[overflow-wrap:anywhere]"
      description="按 DeviceForge 规范安装插件、工具包或合并配置，无须先发布市场。根启动配置可在服务器运行 deviceforge config path 查看路径，再用 config import 管理。"
      footer={
        completed ? (
          <>
            {debugRetry && <Button variant="outline" disabled={pending || !!debugUnavailable} onClick={() => void run('debug')}>重试打开调试器</Button>}
            <Button onClick={() => close(false)}>完成</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => close(false)}>
              关闭
            </Button>
            {pending ? (
              <Button
                variant="outline"
                onClick={() => {
                  request.current?.abort();
                  request.current = null;
                  setPending(false);
                  setPreview(null);
                  setFeedback('已取消等待。提交可能已生效，请刷新实际状态后再操作。');
                }}
              >
                取消当前等待
              </Button>
            ) : preview ? (
              <Button onClick={() => void run('import')}>确认导入</Button>
            ) : (
              <Button onClick={() => void run('preview')}>检查导入内容</Button>
            )}
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-4 [&>*]:min-w-0">
        <SelectField
          label="导入类型"
          value={kind}
          disabled={pending || completed}
          options={[
            { value: 'plugin', label: '插件（清单文件夹 / ZIP / TGZ）' },
            { value: 'tool', label: '工具包（ZIP 与工具清单）' },
            { value: 'config', label: '配置（DeviceForge JSON）' },
          ]}
          onValueChange={(value) => {
            if (value !== 'plugin' && value !== 'tool' && value !== 'config') return;
            setKind(value);
            setDebugAfterImport(false);
            setFile(null);
            setSelection(null);
            setManifestFile(null);
            setManifest(null);
            setModuleId('');
            invalidate();
          }}
        />
        <FileDropzone
          label={
            kind === 'plugin'
              ? '选择插件便携包'
              : kind === 'tool'
                ? '选择工具 ZIP'
                : '选择配置 JSON'
          }
          file={file}
          disabled={pending || completed}
          accept={kind === 'plugin' ? '.zip,.tgz,.tar.gz' : kind === 'tool' ? '.zip' : '.json'}
          onFileChange={(value) => {
            setFile(value);
            setSelection(null);
            invalidate();
          }}
        />
        {kind === 'plugin' && <>
          <input hidden type="file" multiple aria-label="选择插件文件夹"
            ref={node => { folder.current = node; node?.setAttribute('webkitdirectory', ''); }} disabled={pending || completed}
            onChange={event => {
              try {
                const next = directorySelection(Array.from(event.target.files ?? []));
                const first = next.files[0];
                if (!first) throw new Error('请选择非空插件文件夹');
                setSelection(next);
                setFile(first.file);
                invalidate();
              } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取文件夹'); }
              event.target.value = '';
            }} />
          <Button variant="outline" disabled={pending || completed} onClick={() => folder.current?.click()}>选择插件文件夹</Button>
          <p className="text-sm text-muted-foreground">{selection ? `已选择 ${selection.name}，${selection.files.length} 个文件。` : '支持 manifest.json 与已构建产物，自动生成安装清单；也兼容原有便携包和完整离线 ZIP。'}</p>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox aria-label="导入后调试此插件" aria-describedby="local-import-debug-help"
              checked={debugAfterImport} disabled={pending || completed || !!debugUnavailable}
              onCheckedChange={value => setDebugAfterImport(value === true)} />
            <span className="min-w-0 space-y-1">
              <span className="block">导入后调试此插件</span>
              <span id="local-import-debug-help" className="block text-xs text-muted-foreground">
                {debugUnavailable ?? '导入成功后打开调试器，带入本次插件；多个组件由你选择，不自动执行业务操作。'}
              </span>
            </span>
          </label>
        </>}
        {kind === 'tool' && (
          <>
            <FileDropzone
              label="选择工具清单 JSON"
              file={manifestFile}
              accept=".json"
              disabled={pending || completed}
              description="沿用工具供应清单；来源 URL 保留为元数据，离线导入不联网。"
              onFileChange={(value) => {
                setManifestFile(value);
                setManifest(null);
                setModuleId('');
                invalidate();
              }}
            />
            <Button
              variant="outline"
              disabled={!manifestFile || pending || completed}
              onClick={() => void run('manifest')}
            >
              读取工具清单
            </Button>
            {manifest && (
              <SelectField
                label="要导入的工具模块"
                value={moduleId}
                disabled={pending || completed}
                options={manifest.modules.map((item) => ({
                  value: item.id,
                  label: `${item.id} · ${item.version}`,
                }))}
                onValueChange={(value) => {
                  setModuleId(value);
                  invalidate();
                }}
              />
            )}
          </>
        )}
        {kind === 'config' && (
          <p className="muted">
            支持业务配置区与已安装服务器插件配置封装；检查后会显示目标和修订，提交期间若配置变化则拒绝覆盖。配置内容不会在预览中展开。
          </p>
        )}
        {preview && (
          <div className="space-y-2 rounded-lg border p-4 [overflow-wrap:anywhere]" role="status">
            <h3>目标：{preview.target}</h3>
            <p>{preview.summary}</p>
            <p>
              文件：{preview.file.name} · {preview.file.size.toLocaleString('zh-CN')} 字节
            </p>
            {preview.kind === 'config' ? (
              <p>
                预期修订：<code>{preview.revision}</code>
              </p>
            ) : (
              <p>
                SHA-256：<code>{preview.sha256}</code>
              </p>
            )}
            {preview.kind === 'tool' && (
              <p className="muted">尚未验证此工具适合当前平台或具备真实设备运行条件。</p>
            )}
          </div>
        )}
        {pending && <p role="status">{completed ? '正在打开调试器…' : '正在处理本地导入…'}</p>}
        {pending && !completed && preview?.kind === 'release' && <InstallationProgress value={installationProgress} />}
        {error && (
          <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            <p>{error}</p>
            {logId && (
              <p>
                日志 ID：<code>{logId}</code>{' '}
                <Button
                  variant="outline"
                  onClick={() => {
                    void (async () => {
                      try {
                        if (!navigator.clipboard) throw new Error('当前浏览器无法写入剪贴板');
                        await navigator.clipboard.writeText(logId);
                        setFeedback('日志 ID 已复制。');
                      } catch {
                        setFeedback('复制失败，请手动选择日志 ID。');
                      }
                    })();
                  }}
                >
                  复制日志 ID
                </Button>
              </p>
            )}
          </div>
        )}
        {feedback && <p role="status">{feedback}</p>}
      </div>
    </DialogShell>
  );
}
