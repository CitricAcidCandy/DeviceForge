import type { JsonData } from '../src/shared/jobs/index.ts';
import { isJsonData, jsonObject } from '../src/shared/jobs/index.ts';

// 只模拟公开配置任务与修订比较，真实生产代码负责提交、消费和页面反馈。
export function createSettingsBrowserFixture() {
  let revision = 1;
  let sections: Record<string, JsonData> = { general: { label: '初始本地配置' } };
  let remoteSource: 'remote' | 'local' = 'local';
  let remote: JsonData = { label: '本地备份值' };
  const writes: { operation: string; input: Readonly<Record<string, unknown>> }[] = [];
  const state = () => ({
    format_version: 1,
    revision: String(revision),
    sections: { ...sections },
  });
  const envelope = (result: unknown) => ({ result, artifacts: [] });
  function execute(
    operation: string,
    input: Readonly<Record<string, unknown>>,
  ): { result?: unknown; error?: string } {
    if (!operation.startsWith('plugin.settings.'))
      throw new Error(`未列出的配置任务：${operation}`);
    const action = operation.slice('plugin.settings.'.length);
    const section = typeof input['section'] === 'string' ? input['section'] : 'general';
    if (action === 'list') return { result: envelope(state()) };
    if (action === 'get')
      return {
        result: envelope({
          format_version: 1,
          revision: String(revision),
          section,
          value: sections[section] ?? null,
        }),
      };
    writes.push({ operation, input });
    if (input['expected_revision'] !== String(revision))
      return { error: '配置修订冲突，请重查后修改' };
    if (action === 'set') {
      if (!isJsonData(input['value'])) throw new Error('配置夹具收到非法值');
      sections[section] = input['value'];
      revision++;
      return { result: envelope(state()) };
    }
    if (action === 'delete') {
      delete sections[section];
      revision++;
      return { result: envelope(state()) };
    }
    if (action === 'import') {
      if (!jsonObject(input['sections'])) throw new Error('配置导入夹具收到非法对象');
      sections = { ...sections, ...input['sections'] };
      revision++;
      return { result: envelope(state()) };
    }
    if (action === 'remote.load') {
      const backup = remoteSource === 'remote';
      if (backup) {
        sections[section] = remote;
        revision++;
      }
      return {
        result: envelope({
          format_version: 1,
          section,
          value: remote,
          source: remoteSource,
          backup_updated: backup,
          revision: String(revision),
          remote_committed: false,
        }),
      };
    }
    if (action === 'remote.save') {
      if (!isJsonData(input['value'])) throw new Error('远端夹具收到非法JSON值');
      remote = input['value'];
      const backup = input['write_local_backup'] !== false;
      if (backup) {
        sections[section] = remote;
        revision++;
      }
      return {
        result: envelope({
          format_version: 1,
          section,
          value: remote,
          source: 'remote',
          backup_updated: backup,
          revision: backup ? String(revision) : null,
          remote_committed: true,
        }),
      };
    }
    throw new Error(`未列出的配置动作：${action}`);
  }
  return {
    execute,
    writes,
    snapshot: state,
    remoteValue: () => remote,
    concurrentWrite() {
      sections['general'] = { label: '并发写入受保护值' };
      revision++;
    },
    setRemote(source: 'remote' | 'local', value: JsonData) {
      remoteSource = source;
      remote = value;
    },
  };
}
