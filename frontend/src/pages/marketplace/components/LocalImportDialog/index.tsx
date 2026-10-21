import { useEffect, useRef, useState } from 'react';
import { Button, DialogShell, FileDropzone, SelectField } from '../../../../components/index.ts';
import { errorLogId } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import {
  localImportPorts,
  previewLocalImport,
  submitLocalImport,
} from '../../local-import/actions.ts';
import { parseLocalToolManifest, readImportJson } from '../../local-import/rules.ts';
import type {
  LocalImportKind,
  LocalImportPreview,
  LocalToolManifest,
} from '../../local-import/types.ts';
import type { PreparationExecutor } from '../../upload-preparation/index.ts';
import './styles.css';

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
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<LocalToolManifest | null>(null);
  const [moduleId, setModuleId] = useState('');
  const [preview, setPreview] = useState<LocalImportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [logId, setLogId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) {
      request.current?.abort();
      request.current = null;
      return;
    }
    setKind('plugin');
    setFile(null);
    setManifestFile(null);
    setManifest(null);
    setModuleId('');
    setPreview(null);
    setPending(false);
    setCompleted(false);
    setError('');
    setLogId(null);
    setFeedback('');
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
  }
  function close(value: boolean) {
    if (!value) request.current?.abort();
    onOpenChange(value);
  }
  async function run(action: 'manifest' | 'preview' | 'import') {
    if (request.current || pending || completed) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    setLogId(null);
    setFeedback('');
    try {
      if (action === 'manifest') {
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
          { kind, file, manifest, moduleId },
          controller.signal,
          prepare,
        );
        controller.signal.throwIfAborted();
        setPreview(result);
      } else {
        if (!preview) throw new Error('请先检查导入内容');
        const result = await submitLocalImport(
          localImportPorts(services),
          preview,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        setFeedback(result);
        setCompleted(true);
        onImported?.();
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
      className="local-import-dialog"
      description="按 DeviceForge 规范安装插件、工具包或合并配置，无须先发布市场。根启动配置可在服务器运行 deviceforge config path 查看路径，再用 config import 管理。"
      footer={
        completed ? (
          <Button onClick={() => close(false)}>完成</Button>
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
      <div className="marketplace-upload-form">
        <SelectField
          label="导入类型"
          value={kind}
          disabled={pending || completed}
          options={[
            { value: 'plugin', label: '插件便携包（ZIP / TGZ）' },
            { value: 'tool', label: '工具包（ZIP 与工具清单）' },
            { value: 'config', label: '配置（DeviceForge JSON）' },
          ]}
          onValueChange={(value) => {
            if (value !== 'plugin' && value !== 'tool' && value !== 'config') return;
            setKind(value);
            setFile(null);
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
            invalidate();
          }}
        />
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
          <div className="marketplace-upload-review local-import-preview" role="status">
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
        {pending && <p role="status">正在处理本地导入…</p>}
        {error && (
          <div role="alert" className="form-error">
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
