import { useEffect, useState } from 'react';
import { Button } from '../../../../components/index.ts';
import type { MarketplaceController } from '../../../../features/marketplace/index.ts';
import type { PreparationExecutor } from '../../upload-preparation/index.ts';
import { LegacyMarketplaceUploadDialog } from '../LegacyMarketplaceUploadDialog/index.tsx';
import { ReleaseUploadDialog } from '../ReleaseUploadDialog/index.tsx';
import type { ReleasePublicationExecutors } from '../ReleaseUploadDialog/types.ts';

export interface MarketplaceUploadDialogProps extends ReleasePublicationExecutors {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly marketplace: MarketplaceController;
  readonly onPublished: () => void | Promise<void>;
  readonly prepare?: PreparationExecutor;
}

export function MarketplaceUploadDialog(props: MarketplaceUploadDialogProps) {
  const [mode, setMode] = useState<'release' | 'legacy'>('release');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (props.open) {
      setMode('release');
      setPending(false);
    }
  }, [props.open]);

  const modeSelector = (
    <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label="发布内容类型">
      <Button type="button" variant={mode === 'release' ? 'default' : 'outline'}
        aria-pressed={mode === 'release'} disabled={pending} onClick={() => setMode('release')}>
        完整功能插件
      </Button>
      <Button type="button" variant={mode === 'legacy' ? 'default' : 'outline'}
        aria-pressed={mode === 'legacy'} disabled={pending} onClick={() => setMode('legacy')}>
        独立组件或其他资源
      </Button>
    </div>
  );
  const shared = {
    open: props.open, onOpenChange: props.onOpenChange, marketplace: props.marketplace,
    onPublished: props.onPublished, modeSelector, onPendingChange: setPending,
  };
  return mode === 'release'
    ? <ReleaseUploadDialog {...shared}
      {...(props.prepareRelease ? { prepareRelease: props.prepareRelease } : {})}
      {...(props.publishRelease ? { publishRelease: props.publishRelease } : {})} />
    : <LegacyMarketplaceUploadDialog {...shared} {...(props.prepare ? { prepare: props.prepare } : {})} />;
}
