import type { components } from '../../../services/api/generated.ts';

// 发布清单直接消费生成模式，避免维护另一套依赖声明协议。
export type ReleaseDependencyManifest = NonNullable<components['schemas']['PluginReleaseManifest']['dependencies']>;
export type ReleaseDependency = ReleaseDependencyManifest['dependencies'][number];
export type ReleaseDependencySource = ReleaseDependency['sources'][number];
