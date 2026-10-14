import { useEffect, useState } from 'react';
import { EmptyState } from '../../../../components/EmptyState/index.tsx';
import type { OpenedProfileArchive } from '../../../../features/android-profile/index.ts';
import type { ProfileSample } from '../../../../features/android-profile/index.ts';

function useBlobUrl(blob: Blob | null): string | null {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) {
      setCurrent(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current.url : null;
}

export function ProfileFrameView({
  archive,
  sample,
}: {
  archive: OpenedProfileArchive;
  sample: ProfileSample;
}) {
  const reference = sample.frame;
  const frame = reference
    ? archive.frames.find((item) => item.reference.filename === reference.filename)
    : null;
  const url = useBlobUrl(frame?.content ?? null);
  if (!reference || !frame)
    return (
      <EmptyState
        title="本点没有画面"
        description={
          archive.timeline.frameReason ??
          (archive.timeline.frameStatus === 'disabled'
            ? '录制时未请求画面'
            : '没有发布与本点关联的画面')
        }
      />
    );
  return (
    <figure className="profile-frame">
      {url && (
        <img
          src={url}
          width={frame.width}
          height={frame.height}
          alt={`${archive.index.package} 第 ${sample.index} 个指标点的采样画面`}
          style={{
            maxWidth: '100%',
            width: 'auto',
            height: 'auto',
            maxHeight: '440px',
            objectFit: 'contain',
          }}
        />
      )}
      <figcaption>
        <p>
          {reference.filename} · {frame.width}×{frame.height} ·{' '}
          {archive.index.frame_kind === 'scrcpy_sampled_frame' ? 'scrcpy 采样帧' : '采样截图'}
        </p>
        <p>
          画面区间：{reference.begin_ns}–{reference.end_ns} ns（boottime）
        </p>
        {reference.device_time_ns !== undefined && (
          <p>
            帧设备时间：{reference.device_time_ns} ns · 选择偏移：
            {reference.selection_delta_ns ?? '未提供'} ns · 时钟误差：
            {reference.clock_error_ns ?? '未提供'} ns
          </p>
        )}
        <p className="muted">
          这是采样画面，不是全部显示帧；画面区间与指标区间独立关联，不插值成逐帧性能。
        </p>
      </figcaption>
    </figure>
  );
}
