import type { ApiError } from '../../shared/api/index.ts';

export type McpJsonValue = null | boolean | number | string | readonly McpJsonValue[] | { readonly [key: string]: McpJsonValue };
export type McpJsonObject = { readonly [key: string]: McpJsonValue };

export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: McpJsonObject;
  readonly outputSchema?: McpJsonObject;
  readonly annotations?: McpJsonObject;
  readonly meta?: McpJsonObject;
}

export interface McpSnapshot {
  readonly tools: readonly McpTool[];
  readonly logId: string | null;
  readonly version: number;
}

export interface McpSubscriptionHandlers {
  readonly changed: (snapshot: McpSnapshot) => void;
  readonly error?: (error: ApiError) => void;
}

export interface McpClient {
  readonly listTools: (signal: AbortSignal) => Promise<McpSnapshot>;
  readonly subscribe: (handlers: McpSubscriptionHandlers, signal: AbortSignal) => Promise<() => Promise<void>>;
  readonly snapshot: () => McpSnapshot;
  readonly dispose: () => Promise<void>;
}
