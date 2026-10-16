import { useId, useRef, useState } from 'react';
import { File, UploadCloud, X } from 'lucide-react';
import { cn } from '../../utils/classnames.ts';
import { Button } from '../Button/index.tsx';
import './styles.css';

export interface FileDropzoneProps {
  readonly file: globalThis.File | null;
  readonly onFileChange: (file: globalThis.File | null) => void;
  readonly accept?: string;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly error?: string;
  readonly id?: string;
  readonly className?: string;
}

function accepts(file: globalThis.File, accept: string | undefined) {
  if (!accept?.trim()) return true;
  return accept.split(',').some((value) => {
    const rule = value.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('.')) return file.name.toLowerCase().endsWith(rule);
    if (rule.endsWith('/*')) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
    return file.type.toLowerCase() === rule;
  });
}

export function FileDropzone({
  file, onFileChange, accept, disabled = false, label = '选择文件',
  description = '点击选择文件，或将文件拖放到这里', error, id, className,
}: FileDropzoneProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const displayedError = error || selectionError;

  function choose(files: FileList | null) {
    if (disabled || !files?.length) return;
    if (files.length !== 1) {
      setSelectionError('每次请选择一个文件');
      return;
    }
    const selected = files.item(0);
    if (!selected) return;
    if (!accepts(selected, accept)) {
      setSelectionError(`请选择支持的文件格式：${accept}`);
      return;
    }
    setSelectionError('');
    onFileChange(selected);
  }

  return (
    <div className={cn('ui-file-field', className)}>
      <div
        className="ui-file-dropzone"
        data-dragging={dragging && !disabled}
        data-disabled={disabled}
        data-invalid={Boolean(displayedError)}
        onDragEnter={(event) => {
          event.preventDefault();
          if (disabled || !event.dataTransfer.types.includes('Files')) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          choose(event.dataTransfer.files);
        }}
      >
        <input
          ref={input}
          className="ui-file-input"
          type="file"
          id={controlId}
          aria-label={label}
          accept={accept}
          disabled={disabled}
          aria-describedby={`${controlId}-hint${displayedError ? ` ${controlId}-error` : ''}`}
          aria-invalid={Boolean(displayedError)}
          onChange={(event) => { choose(event.target.files); event.target.value = ''; }}
        />
        <label className="ui-file-picker" htmlFor={controlId}>
          <span className="ui-file-icon" aria-hidden="true"><UploadCloud /></span>
          <span className="ui-file-title">{label}</span>
          <span className="ui-file-description" id={`${controlId}-hint`}>{description}</span>
          <span className="ui-file-choose" aria-hidden="true">浏览文件</span>
        </label>
      </div>
      {file && (
        <div className="ui-file-selected" aria-live="polite">
          <File aria-hidden="true" />
          <span><strong>{file.name}</strong><small>{new Intl.NumberFormat('zh-CN').format(file.size)} 字节</small></span>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`移除文件 ${file.name}`} onClick={() => { setSelectionError(''); onFileChange(null); input.current?.focus(); }}>
            <X />
          </Button>
        </div>
      )}
      {displayedError && <small className="ui-file-error" id={`${controlId}-error`} role="alert">{displayedError}</small>}
    </div>
  );
}
