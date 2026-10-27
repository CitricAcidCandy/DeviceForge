import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { HostError } from '../../plugin-sdk/models.ts';
import type { JsonValue } from '../../plugin-sdk/models.ts';

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
// 每次登记自行持有编译后的校验器，撤销贡献即可释放，不积累全局契约缓存。
export function compileServiceSchema(schema: JsonValue | undefined): ValidateFunction | null {
  if (schema === undefined) return null;
  if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema)))
    throw new Error('服务 Schema 必须是对象或布尔值');
  if (JSON.stringify(schema).length > 65536) throw new Error('服务 Schema 超过 64 KiB');
  const validator = ajv.compile(schema);
  if (typeof schema === 'object') ajv.removeSchema(schema);
  return validator;
}
export function checkServiceValue(validator: ValidateFunction | null, value: JsonValue, stage: 'input' | 'output', logId: string | null = null) {
  if (validator && !validator(value))
    throw new HostError('protocol', `service_${stage}_invalid`, `服务${stage === 'input' ? '输入' : '输出'}不符合契约`, logId);
}
