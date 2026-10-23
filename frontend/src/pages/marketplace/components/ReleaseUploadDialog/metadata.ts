import type { MarketplacePublishEntry } from '../../../../features/marketplace/index.ts';
import type { ReleasePublicationPlan } from '../../release-publication/index.ts';
import {
  createMarketplacePublishEntry,
  initialMarketplaceUploadDraft,
  type MarketplaceUploadDraft,
} from '../../upload.ts';

export function releaseUploadDraft(plan: ReleasePublicationPlan): MarketplaceUploadDraft {
  const variants = plan.manifest.components.flatMap((component) => component.variants);
  return {
    ...initialMarketplaceUploadDraft,
    id: plan.manifest.id,
    name: plan.manifest.name,
    version: plan.manifest.version,
    description: plan.manifest.description,
    summary: plan.manifest.description,
    license: '',
    platforms: [...new Set(variants.map((variant) => variant.platform))].join(','),
    architectures: '',
    details: JSON.stringify({
      release_format_version: plan.manifest.format_version,
      host_api_version: plan.manifest.host_api_version,
    }),
  };
}

export function releaseUploadMetadata(
  plan: ReleasePublicationPlan,
  draft: MarketplaceUploadDraft,
): MarketplacePublishEntry {
  const entry = createMarketplacePublishEntry({
    ...draft,
    id: plan.manifest.id,
    name: plan.manifest.name,
    version: plan.manifest.version,
    description: plan.manifest.description,
    kind: 'plugin',
    visibility: 'market',
    details: JSON.stringify({
      release_format_version: plan.manifest.format_version,
      host_api_version: plan.manifest.host_api_version,
    }),
  }, plan.manifestSha256);
  return {
    ...entry,
    id: plan.manifest.id,
    name: plan.manifest.name,
    version: plan.manifest.version,
    description: plan.manifest.description,
  };
}
