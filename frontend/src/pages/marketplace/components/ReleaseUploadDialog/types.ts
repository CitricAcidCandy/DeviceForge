import type { ReactNode } from 'react';
import type { MarketplaceController } from '../../../../features/marketplace/index.ts';
import type {
  prepareReleasePublication,
  publishReleasePublication,
} from '../../release-publication/index.ts';

export interface ReleasePublicationExecutors {
  readonly prepareRelease?: typeof prepareReleasePublication;
  readonly publishRelease?: typeof publishReleasePublication;
}

export interface ReleaseUploadDialogProps extends ReleasePublicationExecutors {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly marketplace: MarketplaceController;
  readonly onPublished: () => void | Promise<void>;
  readonly modeSelector?: ReactNode;
  readonly onPendingChange?: (pending: boolean) => void;
}
