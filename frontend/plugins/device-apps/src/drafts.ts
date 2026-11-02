import type { ReactNode } from 'react';
import type { DeviceRef } from '@deviceforge/plugin-sdk';
import type { AppList, DeviceBusinessResult } from '@deviceforge/business-kit/device';
import type { PackageSdkRule } from './model/package-analysis/index.ts';

export interface DraftCell<T> { value: T }
const cell = <T>(value: T): DraftCell<T> => ({ value });
export type PackageAction = 'manifest' | 'signature' | 'extract_apk' | 'build_apks' |
  'decode' | 'scan_sdks' | 'extract_splits';
export interface PackageReport {
  title: string;
  content: ReactNode;
  raw: unknown;
  download?: {
    filename: string;
    run(signal: AbortSignal): Promise<{ data: Blob; logId: string | null }>;
  };
}
export interface Confirmation {
  readonly reference: DeviceRef;
  readonly identifier: string;
  readonly capability: 'app.uninstall' | 'app.reset';
}
export interface AppReport {
  readonly key: string;
  readonly identifier: string;
  readonly capability: 'app.start' | 'app.stop' | 'app.uninstall' | 'app.detail' | 'app.reset' |
    'app.install' | 'app.install_apks';
  readonly data: DeviceBusinessResult;
}

/** 草稿属于工作区实例；隐藏或 DOM 重挂不会把另一实例的字段带进来。 */
export function createDeviceAppsDrafts() {
  return {
    apps: {
      list: cell<{ key: string; data: AppList } | null>(null),
      report: cell<AppReport | null>(null),
      filter: cell(''), visible: cell(60), ability: cell(''), artifactId: cell(''),
      filename: cell(''), format: cell<'apk' | 'apks' | 'hap'>('apk'),
      modules: cell(''), installOpen: cell(true), confirmation: cell<Confirmation | null>(null),
    },
    packages: {
      analysisOpen: cell(false), artifactId: cell(''), filename: cell(''),
      action: cell<PackageAction>('manifest'), report: cell<PackageReport | null>(null),
      module: cell(''), entry: cell(''), mode: cell<'default' | 'universal'>('default'),
      ruleName: cell(''), rulePackage: cell(''), ruleClass: cell(''),
      rules: cell<readonly PackageSdkRule[]>([]),
      sdk: cell(''), density: cell(''), abis: cell(''), locales: cell(''),
      modules: cell(''), instant: cell(false), features: cell(''), extensions: cell(''),
      codename: cell(''), tier: cell(''),
    },
  };
}
