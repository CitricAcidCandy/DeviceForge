import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { Channel, PROFILE, SDK_VERSION, block, object, type Identity, type Payload } from "./protocol.js";
import { runSdk, threadId, type Start } from "./sdk.js";
import { exitCandidate } from "./shutdown.js";

function identity(): Identity {
  const call_id = process.env.DF_SDK_CALL_ID ?? "";
  const nonce = process.env.DF_SDK_NONCE ?? "";
  if (call_id.length === 0 || call_id.length > 64 || !/^[0-9a-f]{64}$/i.test(nonce)) throw new Error("调用身份无效");
  return { call_id, nonce };
}

function start(payload: Payload): Start {
  const required = ["kind", "project_id", "project_root", "sdk_entry", "proxy_executable", "temporary_root", "thread_options"];
  const optional = ["thread_id", "output_schema"];
  if (payload.kind !== "begin" || required.some((field) => !(field in payload))
      || Object.keys(payload).some((field) => !required.includes(field) && !optional.includes(field))
      || typeof payload.project_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.project_id)
      || !object(payload.thread_options)) throw new Error("开始负载无效");
  for (const field of ["project_root", "sdk_entry", "proxy_executable", "temporary_root"]) {
    if (typeof payload[field] !== "string" || !isAbsolute(payload[field])) throw new Error("开始路径无效");
  }
  if (payload.thread_id !== undefined) threadId(payload.thread_id);
  return payload as unknown as Start;
}

async function prompt(channel: Channel): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const payload = await channel.next();
    if (!payload) throw new Error("提示词未完成");
    if (payload.kind === "prompt_end" && Object.keys(payload).length === 1) break;
    if (payload.kind !== "prompt_bytes" || Object.keys(payload).sort().join(",") !== "bytes,kind") throw new Error("提示词分片无效");
    const bytes = block(payload);
    total += bytes.length;
    if (total > 131_072 * 4) throw new Error("提示词字节超限");
    chunks.push(bytes);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  if (text.trim().length === 0 || Array.from(text).length > 131_072) throw new Error("提示词字符超限或为空");
  return text;
}

async function invocation(channel: Channel, call: Identity): Promise<void> {
  const abort = new AbortController();
  let closing = false;
  let transportFailed = false;
  let outcome: "success" | "cancelled" | "failed" = "failed";
  await channel.send({ kind: "hello", profile: PROFILE, sdk_version: SDK_VERSION, process_id: process.pid });
  const opening = await channel.next();
  if (!opening) throw new Error("缺少开始帧");
  const context = start(opening);
  const input = await prompt(channel);
  const controls = (async () => {
    while (true) {
      const payload = await channel.next();
      if (payload === undefined) {
        if (!closing) { transportFailed = true; abort.abort(); }
        return;
      }
      if (payload.kind !== "stop" || Object.keys(payload).sort().join(",") !== "kind,reason"
          || !["cancelled", "timeout", "transport_failure"].includes(String(payload.reason))) {
        transportFailed = true;
        abort.abort();
        throw new Error("停止控制无效");
      }
      abort.abort();
    }
  })().catch(() => { transportFailed = true; abort.abort(); });
  try {
    const result = await runSdk(context, input, abort.signal, async (event) => {
      const bytes = Buffer.from(JSON.stringify(event));
      if (bytes.length > 64 * 1024) throw new Error("SDK事件超过原始单行限额");
      await channel.send({ kind: "event_start" });
      await channel.sendBytes("event_bytes", bytes);
      await channel.send({ kind: "event_end" });
    });
    if (transportFailed || abort.signal.aborted) throw new Error("SDK传输或业务已停止");
    outcome = "success";
    await channel.send({ kind: "candidate_start", outcome, thread_id: result.thread_id, event_count: result.event_count });
    await channel.sendBytes("text_bytes", Buffer.from(result.text));
    await channel.send({ kind: "candidate_end" });
  } catch {
    outcome = abort.signal.aborted && !transportFailed ? "cancelled" : "failed";
    await channel.send({ kind: "candidate_start", outcome, error_code: transportFailed ? "transport_failed" : outcome === "cancelled" ? "aborted" : "provider_failed" });
    await channel.send({ kind: "candidate_end" });
  } finally {
    closing = true;
    await channel.finish();
    channel.destroy();
    await controls;
  }
  exitCandidate(call, outcome);
}

async function main(): Promise<void> {
  const call = identity();
  const portText = process.env.DF_SDK_WORKER_PORT ?? "";
  if (!/^[0-9]{1,5}$/.test(portText)) throw new Error("内部连接端口无效");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("内部连接端口无效");
  const socket = createConnection({ host: "127.0.0.1", port });
  const channel = new Channel(socket, call, "worker");
  try { await invocation(channel, call); } finally { channel.destroy(); }
}

try { await main(); } catch {
  process.stderr.write("SDK桥接协议失败\n");
  process.exitCode = 1;
}
