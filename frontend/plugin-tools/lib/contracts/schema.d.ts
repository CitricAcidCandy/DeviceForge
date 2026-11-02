import type { ContractJson } from './json.js';
/** 类型表达结构，长度、正则、整数范围等仍由随附原 Schema 在运行期校验。 */
export declare function schemaType(value: ContractJson, path: string): string;
