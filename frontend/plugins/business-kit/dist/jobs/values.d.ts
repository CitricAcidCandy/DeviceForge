import { ApiError } from "../api/index.js";
export type JsonData = null | boolean | number | string | JsonData[] | {
    [key: string]: JsonData;
};
export declare function isJsonData(value: unknown): value is JsonData;
export declare function requireJson(value: unknown): JsonData;
export declare function invalidBusinessResult(module: string, logId: string | null): ApiError;
export declare const nonemptyText: (value: unknown) => value is string;
export declare const naturalNumber: (value: unknown) => value is number;
export declare const decimalU64: (value: unknown) => value is string;
export declare const onlyKeys: (value: Record<string, unknown>, keys: readonly string[]) => boolean;
export declare function jsonObject(value: unknown): value is {
    [key: string]: JsonData;
};
