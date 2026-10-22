import {
  createBrowserConfigurationPersistence,
  createBrowserConfigurations,
} from '../src/features/plugin-configurations/index.ts';
import type { BrowserConfigurationRecord } from '../src/features/plugin-configurations/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { isBrowserConfigurationRecord } from '../src/services/api/browser-plugin-configuration.ts';
import { isSchemaValue } from '../src/utils/schema.ts';
import { failure, requestUrl, success } from './fixtures.ts';

export function browserConfigurationServer() {
  const records = new Map<string, BrowserConfigurationRecord>();
  const calls: { id: string; method: string; expected: string | null | undefined }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const key = url.origin + ':' + id;
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      calls.push({ id, method, expected: undefined });
      return success({ record: records.get(key) ?? null });
    }
    const body: unknown = JSON.parse(String(init?.body));
    if (
      method !== 'PATCH' ||
      !body ||
      typeof body !== 'object' ||
      !('record' in body) ||
      !('expected_revision' in body) ||
      (body.expected_revision !== null && typeof body.expected_revision !== 'string') ||
      !isBrowserConfigurationRecord(body.record)
    )
      return failure('bad_request', 400);
    calls.push({ id, method, expected: body.expected_revision });
    if ((records.get(key)?.revision ?? null) !== body.expected_revision)
      return failure('configuration_conflict', 409);
    const value = body.record;
    const values = value.values;
    if (!isSchemaValue(values) || !values || typeof values !== 'object' || Array.isArray(values))
      return failure('bad_request', 400);
    const record: BrowserConfigurationRecord = {
      version: value.version,
      values,
      revision: value.revision,
      applied: value.applied,
      sensitivePaths: value.sensitivePaths,
    };
    records.set(key, record);
    return success({ record });
  };
  const persistence = (baseUrl = 'http://localhost:7031') =>
    createBrowserConfigurationPersistence(createApiClient({ baseUrl, transport }));
  const model = (baseUrl = 'http://localhost:7031', legacyStorage?: Storage) =>
    createBrowserConfigurations({ baseUrl, persistence: persistence(baseUrl), legacyStorage });
  return { records, calls, transport, persistence, model };
}
