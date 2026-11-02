export type ContractJson = null | boolean | number | string | ContractJson[] | ContractObject;
export interface ContractObject {
    [key: string]: ContractJson;
}
export declare function invalid(path: string, message: string): never;
export declare function object(value: ContractJson | undefined, path: string): ContractObject;
export declare function text(value: ContractJson | undefined, path: string): string;
export declare function fields(value: ContractObject, allowed: readonly string[], path: string): void;
/** 只接收有界 JSON 数据；拒绝访问器、循环及非有限数，不触发清单中的自定义行为。 */
export declare function manifestJson(input: unknown): ContractJson;
/** 生成 JavaScript 对象字面量；计算属性保留 __proto__ 的普通 JSON 键语义。 */
export declare function literal(value: ContractJson, indent?: number): string;
