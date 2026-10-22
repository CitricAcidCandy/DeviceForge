import type { paths } from './generated.ts';
import type { Endpoint } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isRecord } from './validation.ts';
import { isSchemaValue } from '../../utils/schema.ts';

type ConfigurationPath = paths['/api/v2/browser-plugin-configurations/{id}'];
type ConfigurationEnvelope =
  ConfigurationPath['get']['responses'][200]['content']['application/json'];
export type BrowserConfigurationViewDto = ConfigurationEnvelope['data'];
export type BrowserConfigurationRecordDto = NonNullable<BrowserConfigurationViewDto['record']>;
export type BrowserConfigurationPatchDto =
  ConfigurationPath['patch']['requestBody']['content']['application/json'];

export function isBrowserConfigurationRecord(
  value: unknown,
): value is BrowserConfigurationRecordDto {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    value.version <= 0xffffffff &&
    isRecord(value.values) &&
    isSchemaValue(value.values) &&
    typeof value.revision === 'string' &&
    !!value.revision.trim() &&
    typeof value.applied === 'string' &&
    !!value.applied.trim() &&
    Array.isArray(value.sensitivePaths) &&
    value.sensitivePaths.every(
      (path: unknown) => typeof path === 'string' && (path === '' || path.startsWith('/')),
    )
  );
}
export function isBrowserConfigurationView(value: unknown): value is BrowserConfigurationViewDto {
  return (
    isRecord(value) &&
    Object.hasOwn(value, 'record') &&
    (value.record === null || isBrowserConfigurationRecord(value.record))
  );
}
const path = (id: string) => `/api/v2/browser-plugin-configurations/${encodedId(id)}`;
export const browserPluginConfigurationEndpoint: Endpoint<string, BrowserConfigurationViewDto> = {
  request: (id) => ({ path: path(id), method: 'GET' }),
  decode: isBrowserConfigurationView,
};
export const patchBrowserPluginConfigurationEndpoint: Endpoint<
  { id: string; body: BrowserConfigurationPatchDto },
  BrowserConfigurationViewDto
> = {
  request: ({ id, body }) => ({
    path: path(id),
    method: 'PATCH',
    body: JSON.stringify(body),
    contentType: 'application/json',
  }),
  decode: isBrowserConfigurationView,
};
