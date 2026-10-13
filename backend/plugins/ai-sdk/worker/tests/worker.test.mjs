import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { block, decode, PROFILE } from "../dist/protocol.js";

const worker = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sdk = fileURLToPath(new URL("../node_modules/@openai/codex-sdk/dist/index.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/exec", import.meta.url));
const identity = { call_id: "worker-qualification", nonce: "a".repeat(64) };

async function qualify(prompt, { cancel = false, malformed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "deviceforge-sdk-worker-"));
  await copyFile(fixture, join(root, "exec"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const connection = once(server, "connection");
  const child = spawn(process.execPath, [worker], {
    cwd: root, windowsHide: true,
    env: {
      ...process.env, DF_SDK_CALL_ID: identity.call_id, DF_SDK_NONCE: identity.nonce,
      DF_SDK_WORKER_PORT: String(port), DF_SDK_PROXY_PORT: String(port), DF_SDK_ROUND: "1",
      DF_SDK_PROFILE: PROFILE, OPENAI_API_KEY: "测试环境不得传给SDK代理",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exited = once(child, "close");
  let socket;
  const timer = setTimeout(() => { child.kill(); socket?.destroy(); }, 5000);
  try {
    [socket] = await connection;
    let received = 0;
    let sent = 0;
    let buffered = Buffer.alloc(0);
    const queue = [];
    let waiting;
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(10);
        if (newline < 0) break;
        const payload = decode(buffered.subarray(0, newline + 1), identity, "worker", ++received);
        buffered = buffered.subarray(newline + 1);
        if (waiting) { const resolve = waiting; waiting = undefined; resolve(payload); } else queue.push(payload);
      }
    });
    socket.on("close", () => { waiting?.(undefined); waiting = undefined; });
    const next = async () => queue.length ? queue.shift() : new Promise((resolve) => { waiting = resolve; });
    const send = (payload) => {
      socket.write(JSON.stringify({ format_version: 1, ...identity, role: "coordinator", sequence: ++sent, payload }) + "\n");
    };
    assert.equal((await next()).kind, "hello");
    send(malformed ? { kind: "begin", project_id: "demo" } : {
      kind: "begin", project_id: "demo", project_root: root, sdk_entry: sdk,
      proxy_executable: process.execPath, temporary_root: root, thread_options: {},
    });
    if (!malformed) {
      send({ kind: "prompt_bytes", bytes: Array.from(Buffer.from(prompt)) });
      send({ kind: "prompt_end" });
    }
    let candidate;
    const text = [];
    let event = [];
    let events = 0;
    while (!malformed) {
      const payload = await next();
      if (!payload) break;
      if (payload.kind === "event_start") event = [];
      if (payload.kind === "event_bytes") event.push(block(payload));
      if (payload.kind === "event_end") {
        const parsed = JSON.parse(Buffer.concat(event).toString("utf8"));
        events += 1;
        if (cancel && parsed.type === "turn.started") send({ kind: "stop", reason: "cancelled" });
      }
      if (payload.kind === "candidate_start") candidate = payload;
      if (payload.kind === "text_bytes") text.push(block(payload));
      if (payload.kind === "candidate_end") break;
    }
    socket.end();
    const [code, signal] = await exited;
    return { code, signal, candidate, text: Buffer.concat(text).toString("utf8"), events, stdout, stderr };
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test("固定worker实际调用官方SDK并自然退出，代理环境排除父密钥", async () => {
  const result = await qualify("成功");
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.candidate.outcome, "success");
  assert.equal(result.text, "真实SDK与模拟CLI");
  assert.equal(result.events, 4);
  assert.equal(result.stderr, "");
  const final = JSON.parse(result.stdout);
  assert.equal(final.kind, "exit_candidate");
  assert.equal(final.nonce, identity.nonce);
});

test("SDK真实非零不发布成功候选或回答", async () => {
  const result = await qualify("失败");
  assert.equal(result.code, 0);
  assert.equal(result.candidate.outcome, "failed");
  assert.equal(result.text, "");
  assert.equal(result.stderr, "");
});

test("合作停止实际AbortSignal且Node自然退出", async () => {
  const result = await qualify("等待取消", { cancel: true });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.candidate.outcome, "cancelled");
  assert.equal(result.text, "");
  assert.equal(JSON.parse(result.stdout).outcome, "cancelled");
});

test("错误开始帧退出失败且不遗留本机连接", async () => {
  const result = await qualify("成功", { malformed: true });
  assert.equal(result.code, 1);
  assert.equal(result.candidate, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "SDK桥接协议失败\n");
});
