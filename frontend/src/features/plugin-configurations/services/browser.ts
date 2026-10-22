import type { ApiClient } from '../../../services/api/index.ts';
import {
  browserPluginConfigurationEndpoint,
  patchBrowserPluginConfigurationEndpoint,
} from '../../../services/api/browser-plugin-configuration.ts';
import type { BrowserConfigurationRecordDto } from '../../../services/api/browser-plugin-configuration.ts';
import { cloneSchemaValue, isSchemaValue } from '../../../utils/schema.ts';
import type {
  BrowserConfigurationPersistence,
  BrowserConfigurationRecord,
} from '../types/browser.ts';

function record(value: BrowserConfigurationRecordDto): BrowserConfigurationRecord {
  if (
    !isSchemaValue(value.values) ||
    value.values === null ||
    typeof value.values !== 'object' ||
    Array.isArray(value.values)
  )
    throw new Error('浏览器插件配置值不是 JSON 对象');
  return {
    version: value.version,
    values: value.values,
    revision: value.revision,
    applied: value.applied,
    sensitivePaths: [...value.sensitivePaths],
  };
}
export function createBrowserConfigurationPersistence(
  client: ApiClient,
): BrowserConfigurationPersistence {
  return {
    async get(id, signal) {
      const result = await client.call(browserPluginConfigurationEndpoint, id, signal);
      signal.throwIfAborted();
      return result.data.record === null ? null : record(result.data.record);
    },
    async save(id, expectedRevision, value, signal) {
      const values = cloneSchemaValue(value.values);
      if (values === null || typeof values !== 'object' || Array.isArray(values))
        throw new Error('浏览器插件配置值不是 JSON 对象');
      const result = await client.call(
        patchBrowserPluginConfigurationEndpoint,
        {
          id,
          body: {
            expected_revision: expectedRevision,
            record: {
              version: value.version,
              values,
              revision: value.revision,
              applied: value.applied,
              sensitivePaths: [...value.sensitivePaths],
            },
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (!result.data.record) throw new Error('服务器保存后未返回浏览器插件配置记录');
      return record(result.data.record);
    },
  };
}
