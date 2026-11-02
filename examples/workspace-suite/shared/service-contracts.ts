// 由 manifest.json 生成；请修改清单后重新生成，不维护第二份契约。
import type { HostResult, Job, ServerServiceAccess, ServiceContract, ServiceRef } from "@deviceforge/plugin-sdk";
// 类型只表达数据结构；长度、正则和数值范围仍以原 Schema 在运行期校验。

export type ExampleWorkspaceNormalizeV1Input = {
  "message": string;
};
export type ExampleWorkspaceNormalizeV1Output = {
  "message": string;
};
export const ExampleWorkspaceNormalizeV1Ref: ServiceRef = {
  "id": "example.workspace.normalize",
  "version": "1"
};
export const ExampleWorkspaceNormalizeV1Schema: ServiceContract = {
  "inputSchema": {
    "additionalProperties": false,
    "properties": {
      "message": {
        "maxLength": 1000,
        "type": "string"
      }
    },
    "required": [
      "message"
    ],
    "type": "object"
  },
  "outputSchema": {
    "additionalProperties": false,
    "properties": {
      "message": {
        "maxLength": 1000,
        "type": "string"
      }
    },
    "required": [
      "message"
    ],
    "type": "object"
  }
};
export const ExampleWorkspaceNormalizeV1: ServiceContract & { readonly ref: ServiceRef; readonly operation: string } = {
  ref: ExampleWorkspaceNormalizeV1Ref,
  ...ExampleWorkspaceNormalizeV1Schema,
  operation: "plugin.workspace_suite.server.normalize",
};

/** 只提交一次并原样返回 Job 回执；业务终态需要调用方按原票据另行查询。 */
export function ExampleWorkspaceNormalizeV1Submit(
  server: ServerServiceAccess,
  input: ExampleWorkspaceNormalizeV1Input,
  signal: AbortSignal,
  generation?: string,
): Promise<HostResult<Job>> {
  return server.submit(ExampleWorkspaceNormalizeV1Ref, input, signal, generation);
}

export {
  ExampleWorkspaceNormalizeV1 as normalizeContract,
  ExampleWorkspaceNormalizeV1Submit as submitNormalize,
};
export type {
  ExampleWorkspaceNormalizeV1Input as NormalizeInput,
  ExampleWorkspaceNormalizeV1Output as NormalizeOutput,
};
