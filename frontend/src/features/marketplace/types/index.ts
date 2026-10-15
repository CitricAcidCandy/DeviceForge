export type MarketplaceKind = 'plugin' | 'tool' | 'config' | 'distribution' | 'resource';
export type MarketplaceMcp = 'none' | 'client' | 'server' | 'both';
export type MarketplaceRestart =
  | 'none'
  | 'browser_refresh'
  | 'plugin_reload'
  | 'service_restart'
  | 'device_restart';

export interface MarketplaceEntry {
  readonly metadata_version: number;
  readonly id: string;
  readonly kind: MarketplaceKind;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly categories: readonly string[];
  readonly applies_to: readonly string[];
  readonly supports_mcp: MarketplaceMcp;
  readonly supports_agent: boolean;
  readonly restart_policy: MarketplaceRestart;
  readonly platforms: readonly string[];
  readonly architectures: readonly string[];
  readonly author?: string | null;
  readonly license?: string | null;
  readonly homepage?: string | null;
  readonly visibility?: 'market' | 'internal';
  readonly resource_id?: string | null;
  readonly details: Record<string, unknown>;
  readonly source: string;
  readonly sourceName: string;
}

export interface MarketplaceQuery {
  readonly kind?: MarketplaceKind;
  readonly category?: string;
  readonly applies_to?: string;
  readonly supports_mcp?: MarketplaceMcp;
  readonly supports_agent?: boolean;
  readonly restart_policy?: MarketplaceRestart;
  readonly platform?: string;
  readonly architecture?: string;
  readonly q?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface MarketplaceSnapshot {
  readonly entries: readonly MarketplaceEntry[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

