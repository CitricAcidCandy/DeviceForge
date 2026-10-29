import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import { decodeDataSnapshot, decodeDataSources, failure, object, text } from './protocol.ts';
import type { DataSnapshot, DataSourceInfo, JsonObject } from './protocol.ts';

export interface DataState {
  readonly dataSources: readonly DataSourceInfo[];
  readonly dataSnapshot: DataSnapshot | null;
  readonly dataConflict: boolean;
  readonly dataNotice: string | null;
}
interface DataPorts {
  readonly snapshot: () => DataState;
  readonly patch: (change: Partial<DataState>) => void;
  readonly run: (label: string, work: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  readonly tool: (name: string, parameters: JsonObject, signal: AbortSignal) => Promise<JsonValue>;
}
function result(value: unknown, sourceId: string): DataSnapshot {
  const snapshot = decodeDataSnapshot(value, sourceId);
  if (!snapshot || snapshot.sourceId !== sourceId)
    throw new Error('插件数据回执缺少有效的源标识、修订或业务值，或来自其他数据源');
  return snapshot;
}

// 仅处理公开数据投影和回执，不拥有表单草稿，也不重放任何写入。
export function createDataActions(ports: DataPorts) {
  return {
    refreshDataSources: () => ports.run('读取数据源目录', async (signal) => {
      const data = await ports.tool('data_catalog', {}, signal);
      ports.patch({ dataSources: decodeDataSources(data), dataNotice: text(object(data).coverage,
        '已读取插件主动登记的数据源；空目录不代表插件没有内部状态。') });
    }),
    readDataSource: (sourceId: string, query: JsonValue = null) => ports.run('读取插件数据', async (signal) => {
      if (!ports.snapshot().dataSources.some((entry) => entry.id === sourceId))
        throw new Error('请先刷新并选择当前目标已登记的数据源');
      const data = result(await ports.tool('data_read', { source_id: sourceId, query }, signal), sourceId);
      ports.patch({ dataSnapshot: data, dataConflict: false, dataNotice: '已读取当前数据与修订。' });
    }),
    writeDataSource: (sourceId: string, expectedRevision: string, value: JsonValue, confirmed: boolean) => ports.run('保存插件数据', async (signal) => {
      const source = ports.snapshot().dataSources.find((entry) => entry.id === sourceId);
      if (!source?.writable) throw new Error('当前数据源只读或尚未登记');
      if (!confirmed) throw new Error('数据写入需要明确确认本次完整替换');
      try {
        const data = result(await ports.tool('data_write', { source_id: sourceId, expected_revision: expectedRevision,
          value, confirmed }, signal), sourceId);
        ports.patch({ dataSnapshot: data, dataConflict: false, dataNotice: data.runtimeApplied === 'pending'
          ? `已保存，待${data.applyPolicy === 'reload' ? '重载' : '下次调用'}生效。` : '已保存并完成回读。' });
      } catch (error) {
        signal.throwIfAborted();
        const problem = failure(error);
        if (/^(debugger_)?(revision_conflict|data_conflict)$/.test(problem.code))
          ports.patch({ dataConflict: true, dataNotice: '数据已发生变化；你的编辑已保留，请读取最新值并比较后再保存。' });
        else ports.patch({ dataNotice: problem.unconfirmed ? '保存结果未确认，请读取实际状态；不会自动重放写入。' : problem.message });
        throw error;
      }
    }),
  };
}
