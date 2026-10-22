import type {
  InstallationBrowserLifecycle, InstallationGateway, InstallationSource, PluginInstallation,
} from '../src/features/plugin-installations/index.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import type { TaskRecord } from '../src/shared/jobs/index.ts';

export const releaseSource: InstallationSource = {
  kind: 'market', sourceUrl: 'https://market.test/resources/release.json',
  releaseId: 'example-release', version: '1.0.0', releaseDigest: 'a'.repeat(64),
};
export function release(enabled = false, version = '1.0.0', revision = 'a'.repeat(64)): PluginInstallation {
  return { id: 'example-release', version, revision, enabled, status: enabled ? 'enabled' : 'installed',
    name: '示例功能', summary: '完整功能', description: '服务器与浏览器组件共同组成一个功能', components: [
      { id: 'example-server', kind: 'server', version, revision, entryPath: 'plugin.wasm', entryUrl: null },
      { id: 'example-browser', kind: 'browser', version, revision, entryPath: 'dist/index.js',
        entryUrl: `/api/v2/plugin-installations/browser/example-browser/revisions/${revision}/assets/dist/index.js` },
    ] };
}
export const result = <T>(data: T, logId = 'directory-log'): ApiResult<T> => ({ data, logId });
export function installationFixture(initial: readonly PluginInstallation[] = []) {
  let records = [...initial];
  const events: string[] = [];
  const jobs = new Map<string, TaskRecord>();
  const submit = (operation: string) => {
    events.push(operation);
    const job: TaskRecord = { id: `job-${jobs.size}`, operation, status: 'succeeded', result: null, error: null };
    jobs.set(job.id, job);
    return result(job, `${operation}-log`);
  };
  const gateway: InstallationGateway = {
    list: async () => { events.push('list'); return result([...records]); },
    plan: async () => { events.push('plan'); return result({ ...release(), issues: [] }); },
    install: async () => { records = [release()]; return submit('install'); },
    update: async () => { records = [release(false, '2.0.0', 'b'.repeat(64))]; return submit('update'); },
    setEnabled: async (id, _revision, enabled) => {
      records = records.map((item) => item.id === id ? { ...item, enabled, status: enabled ? 'enabled' : 'installed' } : item);
      return submit(enabled ? 'enable-server' : 'disable-server');
    },
    uninstall: async () => { records = []; return submit('uninstall'); },
    getJob: async (id) => {
      events.push(`wait:${id}`);
      const job = jobs.get(id);
      if (!job) throw new Error('没有提交对应任务');
      return result(job, 'terminal-log');
    },
  };
  const browser: InstallationBrowserLifecycle = {
    enable: async (_installation, component) => { events.push(`browser:${component.id}`); },
    disable: async (component) => { events.push(`cleanup:${component.id}`); },
  };
  return { gateway, browser, events, records: () => records };
}
