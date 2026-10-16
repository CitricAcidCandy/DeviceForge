import { useEffect, useRef, useState } from 'react';
import { Button, FileDropzone } from '../../../../components/index.ts';
import { directorySelection, droppedSelection } from '../../upload-preparation/directory.ts';
import type { UploadSelection } from '../../upload-preparation/index.ts';
import './styles.css';

export function MarketplaceUploadContent({ selection, disabled, onChange }: {
  selection: UploadSelection | null;
  disabled: boolean;
  onChange(selection: UploadSelection | null): void;
}) {
  const [mode, setMode] = useState<'file' | 'directory' | 'archive'>('file');
  const [error, setError] = useState<string | null>(null);
  const folder = useRef<HTMLInputElement | null>(null);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  return <section className="marketplace-upload-content" aria-label="上传内容选择"
    onDragOver={event => { event.preventDefault(); }}
    onDrop={event => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      reading.current?.abort();
      const controller = new AbortController();
      reading.current = controller;
      const files = Array.from(event.dataTransfer.files);
      void droppedSelection(event.dataTransfer.items, controller.signal).then(directory => {
        if (controller.signal.aborted) return;
        setError(null);
        if (directory) { setMode('directory'); onChange(directory); }
        else if (files.length === 1 && files[0]) onChange({ mode: 'file', name: files[0].name, files: [{ path: files[0].name, file: files[0] }] });
        else setError('请拖入单个文件或一个文件夹；不支持目录 API 时请使用 ZIP/TGZ');
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取目录，请使用 ZIP/TGZ'); });
    }}>
    <div className="marketplace-upload-modes" role="group" aria-label="上传方式">
      {([['file', '选择文件'], ['directory', '选择文件夹'], ['archive', '已有压缩包']] as const).map(([value, label]) =>
        <Button key={value} type="button" variant={mode === value ? 'default' : 'outline'} disabled={disabled} aria-pressed={mode === value}
          onClick={() => { reading.current?.abort(); setMode(value); setError(null); onChange(null); if (value === 'directory') folder.current?.click(); }}>{label}</Button>)}
    </div>
    <input hidden type="file" multiple aria-label="选择上传文件夹" ref={node => { folder.current = node; node?.setAttribute('webkitdirectory', ''); }} disabled={disabled}
      onChange={event => { try { onChange(directorySelection(Array.from(event.target.files ?? []))); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取目录'); } event.target.value = ''; }} />
    {mode !== 'directory' && <FileDropzone label={mode === 'archive' ? '已有 ZIP / TGZ' : '资源文件'}
      description="可拖入一个文件夹；插件须提供已构建的便携目录或归档"
      {...(mode === 'archive' ? { accept: '.zip,.tgz,.tar.gz' } : {})}
      file={selection?.files.length === 1 ? selection.files[0]?.file ?? null : null} disabled={disabled}
      onFileChange={file => { setError(null); onChange(file ? { mode, name: file.name, files: [{ path: file.name, file }] } : null); }} />}
    {mode === 'directory' && <p className="muted">{selection ? `已选择 ${selection.name}，${selection.files.length} 个文件` : '请选择文件夹，或将文件夹拖入这里。浏览器不支持时请使用 ZIP/TGZ。'}</p>}
    <p className="muted">目录上限 256 MiB / 4096 项；插件归档上限 64 MiB；单文件资源上限 2 GiB。上传不执行构建或安装脚本。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
