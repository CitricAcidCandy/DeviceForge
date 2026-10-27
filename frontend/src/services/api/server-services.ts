import type { components } from './generated.ts';
import type { Endpoint, JobDto } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isArrayOf, isJob, isRecord } from './validation.ts';
import { isSchemaValue } from '../../utils/schema.ts';

export type ServerServiceDto = components['schemas']['ServiceInfo'];
export type ServerServiceCall = components['schemas']['ServiceCallRequest'];

export function isServerService(value: unknown): value is ServerServiceDto {
  if (!isRecord(value) || !isRecord(value.service) || !isRecord(value.contract) || !isRecord(value.provider)) return false;
  const provider = value.provider;
  return typeof value.service.id === 'string' && !!value.service.id &&
    typeof value.service.version === 'string' && !!value.service.version.trim() &&
    isSchemaValue(value.contract.input_schema) && isSchemaValue(value.contract.output_schema) &&
    typeof value.operation === 'string' && !!value.operation &&
    ['id', 'version', 'generation'].every((key) => typeof provider[key] === 'string' && !!provider[key]) &&
    typeof value.available === 'boolean' &&
    (value.unavailable_reason === null || typeof value.unavailable_reason === 'string');
}
export const serverServicesEndpoint: Endpoint<void, ServerServiceDto[]> = {
  request: () => ({ path: '/api/v2/services', method: 'GET' }),
  decode: isArrayOf(isServerService),
};
export const callServerServiceEndpoint: Endpoint<{ id: string; body: ServerServiceCall }, JobDto> = {
  request: ({ id, body }) => {
    if (typeof body.version !== 'string' || !body.version.trim() || !isSchemaValue(body.input) ||
      (body.generation !== undefined && body.generation !== null && (typeof body.generation !== 'string' || !body.generation)))
      throw new Error('服务调用需要精确字符串版本、JSON 输入及有效的可选代际');
    return { path: `/api/v2/services/${encodedId(id)}/calls`, method: 'POST',
      body: JSON.stringify(body), contentType: 'application/json' };
  },
  decode: isJob,
};
