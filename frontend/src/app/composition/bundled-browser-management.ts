import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose } from '../../plugin-sdk/index.ts';
import type { createBundledDebugger } from '../product/bundled-debugger.ts';
import type { createOfficialPlugins } from './official-plugins.ts';
import type { BundledBrowserEntry, BundledBrowserManagement } from './browser-management.ts';

export interface BundledBrowserSources {
  readonly official: Pick<ReturnType<typeof createOfficialPlugins>, 'snapshot' | 'subscribe' | 'setEnabled'> | null;
  readonly debugger: Pick<ReturnType<typeof createBundledDebugger>, 'identity' | 'snapshot' | 'subscribe' | 'setEnabled'> | null;
}

/** 公开管理只转交原来源及其偏好入口，不凭插件 ID 直接装载或绕过独立安装核对。 */
export function bundledBrowserManagement(sources: BundledBrowserSources): BundledBrowserManagement {
  return {
    snapshot(): readonly BundledBrowserEntry[] {
      const official = sources.official?.snapshot() ?? [];
      const debuggerSource = sources.debugger;
      if (!debuggerSource) return official;
      const state = debuggerSource.snapshot();
      return [...official, {
        ...debuggerSource.identity, title: '插件调试器', phase: state.phase, error: state.message,
      }];
    },
    async setEnabled(id, enabled, signal) {
      signal.throwIfAborted();
      const official = sources.official;
      const fromOfficial = official?.snapshot().some((entry) => entry.id === id) ?? false;
      const debuggerSource = sources.debugger;
      const fromDebugger = debuggerSource?.identity.id === id;
      if (fromOfficial && fromDebugger)
        throw new HostError('protocol', 'ambiguous_bundled_source', '此插件存在多个随附来源，请核对实际来源后再管理');
      if (fromOfficial && official) await official.setEnabled(id, enabled, signal);
      else if (fromDebugger && debuggerSource) await debuggerSource.setEnabled(enabled, signal);
      else throw new HostError('protocol', 'bundled_browser_unavailable', '当前随附目录没有此插件');
    },
    subscribe(listener): Dispose {
      const releases: Dispose[] = [];
      try {
        if (sources.official) releases.push(sources.official.subscribe(listener));
        if (sources.debugger) releases.push(sources.debugger.subscribe(listener));
      } catch (error) {
        for (const release of releases) void Promise.resolve().then(release).catch(() => undefined);
        throw error;
      }
      let disposal: Promise<void> | null = null;
      return () => {
        disposal ??= Promise.allSettled(releases.map((release) => Promise.resolve().then(release))).then((results) => {
          const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, '随附管理订阅未完全释放');
        });
        return disposal;
      };
    },
  };
}
