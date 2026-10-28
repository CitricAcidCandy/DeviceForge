// 公开纯规则契约；运行时输入由归一化函数检查，调用端不假定原始 JSON 已合法。
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Entrypoint {
  runtime: 'browser' | 'native' | 'node' | 'script';
  path: string;
  dependency?: { id: string; entry: string };
}
export interface Component {
  id: string; version: string; kind: 'server' | 'browser'; root: string;
  package_name: string; files: string[]; entrypoints: Record<string, Entrypoint>;
  plugin: { [key: string]: Json };
}
export interface DependencySource {
  kind: 'market' | 'official'; url: string; platform: string; version: string;
  sha256: string; size: number; format: 'zip' | 'tgz' | 'file'; entries: Record<string, string>;
}
export interface Dependency {
  id: string; name: string; version_requirement: string; entries: string[]; required?: boolean;
  requires?: string[]; sources?: DependencySource[];
  discovery?: { kind: string; value: string; entries: Record<string, string> }[];
  probe?: { entry: string; args?: string[]; pattern: string; timeout_ms?: number };
  bindings?: { component_id?: string; config_pointer: string; entry: string }[];
}
export interface Dependencies { format_version: 1; dependencies: Dependency[] }
export interface DependencyFile {
  file: string; platform: string; version: string; format: 'zip' | 'tgz' | 'file';
  entries: Record<string, string>; sha256?: string; size?: number;
}
export interface Variant {
  platform: string; path: string; sha256: string; size: number; format: 'zip' | 'tgz' | 'file';
  entries?: Record<string, string>;
}
export interface Release {
  format_version: 1 | 2; host_api_version: 2; id: string; version: string; name: string; description: string;
  components: { id: string; version: string; kind: 'browser' | 'server'; variants: Variant[] }[];
  tools?: { id: string; version: string; required?: boolean; variants: Variant[]; bindings: Json[] }[];
  requirements?: Json[]; dependencies?: Dependencies;
}
export interface Manifest {
  manifest_version: 1; id: string; version: string; name: string; description: string;
  market?: { [key: string]: Json }; components: Component[]; release: Release;
  dependency_files: Record<string, DependencyFile | DependencyFile[]>;
}
export interface MarketMetadata {
  metadata_version: 1; id: string; name: string; kind: 'plugin'; version: string;
  summary: string; description: string; keywords: string[]; categories: string[]; applies_to: string[];
  platforms: string[]; architectures: string[]; supports_mcp: 'none' | 'client' | 'server' | 'both';
  supports_agent: boolean;
  restart_policy: 'none' | 'browser_refresh' | 'plugin_reload' | 'service_restart' | 'device_restart';
  visibility: 'market' | 'internal'; details: { [key: string]: Json };
  author?: string; license?: string; homepage?: string;
}
export function normalizeManifest(value: unknown): Manifest;
export function marketMetadata(declaration: Manifest, identity?: Component | Manifest, details?: { [key: string]: Json }): MarketMetadata;
export function componentMetadata(declaration: Manifest, component: Component, dependencies: Dependencies): Map<string, string>;
export function validateRelease(value: unknown, options?: { source?: boolean }): Release;
export function releaseResources(value: Release): Variant[];
export function relativePath(value: unknown): string;
export function validateDependencies(value: unknown, options?: { components?: Set<string>; owner?: string }): Dependencies;
export function compatibleDependencyVersion(requirement: string, actual: string): boolean;
export function dependencyUrl(source: DependencySource): URL | null;
