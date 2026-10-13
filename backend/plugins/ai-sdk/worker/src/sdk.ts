import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Codex, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { PROFILE, SDK_VERSION, object } from "./protocol.js";

export const SDK_ENTRY_SHA256 = "340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4";
export type SdkConstructor = new (options: ConstructorParameters<typeof Codex>[0]) => Codex;
export type SdkTurn = { thread_id: string; text: string; event_count: number };
export type Start = {
  project_id: string;
  project_root: string;
  sdk_entry: string;
  proxy_executable: string;
  temporary_root: string;
  thread_id?: string;
  thread_options: ThreadOptions;
  output_schema?: unknown;
};

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error("SDK档案文件资格无效");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error("SDK档案文件超限");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export function threadId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("SDK线程标识无效");
  }
  return value.toLowerCase();
}

export async function loadSdk(entry: string): Promise<SdkConstructor> {
  if (!isAbsolute(entry)) throw new Error("SDK入口须为绝对路径");
  const resolved = await realpath(entry);
  const source = await readBounded(resolved, 256 * 1024);
  if (source.length > 256 * 1024 || createHash("sha256").update(source).digest("hex") !== SDK_ENTRY_SHA256) {
    throw new Error("SDK入口内容不符合固定档案");
  }
  const packageBytes = await readBounded(join(dirname(dirname(resolved)), "package.json"), 64 * 1024);
  if (packageBytes.length > 64 * 1024) throw new Error("SDK包元数据超限");
  const metadata: unknown = JSON.parse(packageBytes.toString("utf8"));
  if (!object(metadata) || metadata.name !== "@openai/codex-sdk" || metadata.version !== SDK_VERSION) {
    throw new Error("SDK包身份或版本不匹配");
  }
  const module: unknown = await import(pathToFileURL(resolved).href);
  if (!object(module) || typeof module.Codex !== "function") throw new Error("SDK缺少官方构造入口");
  return module.Codex as SdkConstructor;
}

function proxyEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["DF_SDK_PROXY_PORT", "DF_SDK_CALL_ID", "DF_SDK_NONCE", "DF_SDK_ROUND", "SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (!environment.DF_SDK_PROXY_PORT || !environment.DF_SDK_CALL_ID || !environment.DF_SDK_NONCE) {
    throw new Error("SDK代理连接未准备");
  }
  return environment;
}

export async function runSdk(
  start: Start, prompt: string, signal: AbortSignal,
  publish: (event: ThreadEvent) => Promise<void>,
): Promise<SdkTurn> {
  const Constructor = await loadSdk(start.sdk_entry);
  if (process.version !== "v24.14.0" || process.env.DF_SDK_PROFILE !== PROFILE) throw new Error("Node版本或SDK档案不匹配");
  process.env.TEMP = start.temporary_root;
  process.env.TMP = start.temporary_root;
  const codex = new Constructor({ codexPathOverride: start.proxy_executable, env: proxyEnvironment() });
  const options: ThreadOptions = { ...start.thread_options, workingDirectory: start.project_root };
  const thread = start.thread_id ? codex.resumeThread(threadId(start.thread_id), options) : codex.startThread(options);
  const turnOptions = start.output_schema === undefined ? { signal } : { signal, outputSchema: start.output_schema };
  const streamed = await thread.runStreamed(prompt, turnOptions);
  const messages = new Map<string, string>();
  let currentThread: string | undefined;
  let completed = false;
  let started = false;
  let events = 0;
  for await (const event of streamed.events) {
    if (signal.aborted) throw new Error("SDK轮次已停止");
    events += 1;
    if (events > 10_000 || completed) throw new Error("SDK事件超限或终态后继续输出");
    switch (event.type) {
      case "thread.started": {
        const identifier = threadId(event.thread_id);
        if (currentThread || (start.thread_id !== undefined && threadId(start.thread_id) !== identifier)) throw new Error("SDK线程归属冲突");
        currentThread = identifier;
        break;
      }
      case "turn.started":
        if (!currentThread || started) throw new Error("SDK轮次开始顺序无效");
        started = true;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        if (!started || event.item.id.length === 0 || event.item.id.length > 128) throw new Error("SDK条目顺序或标识无效");
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          if (messages.has(event.item.id)) throw new Error("SDK重复完成回答条目");
          messages.set(event.item.id, event.item.text);
          if (Buffer.byteLength([...messages.values()].join("\n")) > 512 * 1024) throw new Error("SDK回答超过512KiB");
        }
        break;
      case "turn.completed":
        if (!started) throw new Error("SDK缺少轮次开始");
        completed = true;
        break;
      case "turn.failed":
      case "error":
        await publish(event);
        throw new Error("SDK提供者返回失败");
    }
    await publish(event);
  }
  const text = [...messages.values()].join("\n");
  if (!completed || !currentThread || thread.id !== currentThread || text.trim().length === 0) {
    throw new Error("SDK缺少完整结束、线程或回答");
  }
  return { thread_id: currentThread, text, event_count: events };
}
