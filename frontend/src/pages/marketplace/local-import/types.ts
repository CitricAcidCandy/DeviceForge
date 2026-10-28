import type { JsonData } from '../../../shared/jobs/index.ts';
import type { PackageMediaType } from '../../../services/api/index.ts';
import type { LocalReleaseIdentity } from './release.ts';

export type LocalImportKind = 'plugin' | 'tool' | 'config';
export type LocalConfiguration =
  | {
      readonly kind: 'settings';
      readonly scope: 'user' | 'workspace';
      readonly owner_id: string;
      readonly sections: { [key: string]: JsonData };
    }
  | {
      readonly kind: 'server_plugin_configuration';
      readonly plugin_id: string;
      readonly values: { [key: string]: JsonData };
    };
export interface LocalToolModule {
  readonly id: string;
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
}
export interface LocalToolManifest {
  readonly value: { [key: string]: JsonData };
  readonly modules: readonly LocalToolModule[];
}
interface PreviewSummary {
  readonly target: string;
  readonly summary: string;
  readonly file: File;
}
export interface ImportedPluginDebugTarget {
  readonly installation: { readonly id: string; readonly revision: string } | null;
  readonly candidates: readonly { readonly kind: 'server' | 'browser'; readonly id: string; readonly version: string }[];
}
export interface LocalImportResult {
  readonly message: string;
  readonly debugTarget: ImportedPluginDebugTarget | null;
}
export type LocalImportPreview = PreviewSummary &
  (
    | {
        readonly kind: 'plugin';
        readonly plugin: {
          readonly id: string;
          readonly version: string;
          readonly kind: 'server' | 'browser';
        };
        readonly mediaType: PackageMediaType;
        readonly sha256: string;
      }
    | {
        readonly kind: 'release';
        readonly release: LocalReleaseIdentity;
        readonly sha256: string;
        readonly expectedRevision?: string | null;
      }
    | {
        readonly kind: 'tool';
        readonly manifest: LocalToolManifest;
        readonly module: LocalToolModule;
        readonly sha256: string;
      }
    | {
        readonly kind: 'config';
        readonly configuration: LocalConfiguration;
        readonly revision: string;
      }
  );
