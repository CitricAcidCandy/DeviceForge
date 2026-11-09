import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Input } from '../../../../components/Input/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import { Switch } from '../../../../components/Switch/index.tsx';
import { cn } from '../../../../utils/classnames.ts';
import type { AdvancedMirroringDraft, AdvancedMirroringErrors } from '../advanced-settings.ts';

export function AdvancedSettings({ draft, errors, controlEnabled, webRtc, onChange }: {
  readonly draft: AdvancedMirroringDraft;
  readonly errors: AdvancedMirroringErrors;
  readonly controlEnabled: boolean;
  readonly webRtc: boolean;
  onChange(patch: Partial<AdvancedMirroringDraft>): void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const invalid = Object.keys(errors).length !== 0;
  return (
    <div className="min-w-0 border-y border-[var(--hairline)]">
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-content`}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-9 w-full items-center gap-1.5 text-left text-xs text-[var(--text-body)] outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <ChevronDown aria-hidden="true" className={cn('size-3.5 shrink-0 text-faint transition-transform', !expanded && '-rotate-90')} />
        <span>高级设置</span>
        {invalid && <span className="ml-auto text-[11px] text-destructive" aria-live="polite">需修正</span>}
      </button>
      <div id={`${id}-content`} hidden={!expanded} inert={!expanded} className="min-w-0 space-y-2 pb-3 pt-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-bitrate`} className="text-xs font-normal text-[var(--text-body)]">视频码率</Label>
          <div className="relative min-w-0">
            <Input id={`${id}-bitrate`} value={draft.videoBitRateMbps} placeholder="服务默认" inputMode="decimal"
              maxLength={64} aria-invalid={Boolean(errors.videoBitRateMbps)}
              aria-describedby={errors.videoBitRateMbps ? `${id}-bitrate-error` : undefined}
              onChange={(event) => onChange({ videoBitRateMbps: event.target.value })}
              className="h-[30px] pr-14 text-xs md:text-xs" />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">Mbps</span>
          </div>
          {errors.videoBitRateMbps && <p id={`${id}-bitrate-error`} role="alert"
            className="text-[11px] leading-[18px] text-destructive">{errors.videoBitRateMbps}</p>}
        </div>
        <div className="flex min-h-[35px] items-center justify-between gap-3">
          <Label htmlFor={`${id}-audio`} className="text-xs font-normal text-[var(--text-body)]">设备声音</Label>
          <Switch id={`${id}-audio`} checked={draft.audio} onCheckedChange={(audio) => onChange({ audio })} />
        </div>
        <div>
          <div className="flex min-h-[35px] items-center justify-between gap-3">
            <Label htmlFor={`${id}-clipboard`} className={cn('text-xs font-normal text-[var(--text-body)]', !controlEnabled && 'text-faint')}>自动同步剪贴板</Label>
            <Switch id={`${id}-clipboard`} checked={controlEnabled && draft.clipboardAutosync} disabled={!controlEnabled}
              aria-describedby={!controlEnabled ? `${id}-clipboard-hint` : undefined}
              onCheckedChange={(clipboardAutosync) => onChange({ clipboardAutosync })} />
          </div>
          {!controlEnabled && <p id={`${id}-clipboard-hint`} className="text-[11px] leading-[17px] text-faint">需开启设备控制</p>}
        </div>
        {webRtc ? (
          <dl className="flex min-h-[35px] items-center justify-between gap-3 text-xs">
            <dt className="text-[var(--text-body)]">自动重连</dt>
            <dd className="text-faint" title="WebRTC 不自动重连">不支持</dd>
          </dl>
        ) : (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-reconnect`} className="text-xs font-normal text-[var(--text-body)]">自动重连次数</Label>
            <Input id={`${id}-reconnect`} type="number" min={0} max={5} step={1}
              value={draft.reconnectAttempts}
              aria-invalid={Boolean(errors.reconnectAttempts)}
              aria-describedby={errors.reconnectAttempts ? `${id}-reconnect-error` : undefined}
              onChange={(event) => onChange({ reconnectAttempts: event.target.value })}
              className="h-[30px] w-[106px] text-xs md:text-xs" />
          </div>
        )}
        {errors.reconnectAttempts && <p id={`${id}-reconnect-error`} role="alert"
          className="text-[11px] leading-[18px] text-destructive">{errors.reconnectAttempts}</p>}
      </div>
    </div>
  );
}
