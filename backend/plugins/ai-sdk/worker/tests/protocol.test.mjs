import assert from "node:assert/strict";
import { test } from "node:test";
import { block, decode, FRAME_LIMIT } from "../dist/protocol.js";
import { loadSdk, threadId } from "../dist/sdk.js";
import { fileURLToPath } from "node:url";

const identity = { call_id: "qualification", nonce: "a".repeat(64) };
const envelope = () => ({ format_version: 1, ...identity, role: "worker", sequence: 1, payload: { kind: "hello" } });
const encoded = (value) => Buffer.from(JSON.stringify(value) + "\n");

test("私有身份、角色、版本与序号拒绝冲突", () => {
  assert.equal(decode(encoded(envelope()), identity, "worker", 1).kind, "hello");
  for (const field of ["call_id", "nonce", "role", "format_version", "sequence", "unknown"]) {
    const mutated = envelope();
    mutated[field] = "incorrect";
    assert.throws(() => decode(encoded(mutated), identity, "worker", 1));
  }
});

test("私有帧完整性与字节范围均有界", () => {
  assert.throws(() => decode(Buffer.from("{}"), identity, "worker", 1));
  assert.throws(() => decode(Buffer.from([255, 10]), identity, "worker", 1));
  assert.throws(() => decode(Buffer.alloc(FRAME_LIMIT + 1), identity, "worker", 1));
  assert.deepEqual(block({ bytes: [0, 255] }), Buffer.from([0, 255]));
  for (const bytes of [[-1], [256], [0.1], null, new Array(8193).fill(0)]) assert.throws(() => block({ bytes }));
});

test("线程只接受规范UUID并统一大小写", () => {
  assert.equal(threadId("ABCDEF12-1234-1234-1234-123456789ABC"), "abcdef12-1234-1234-1234-123456789abc");
  for (const value of [null, "", "external", "12345678123412341234123456789abc"]) assert.throws(() => threadId(value));
});

test("固定官方SDK模块实际加载且入口哈希匹配", async () => {
  const entry = fileURLToPath(new URL("../node_modules/@openai/codex-sdk/dist/index.js", import.meta.url));
  const Constructor = await loadSdk(entry);
  const codex = new Constructor({ codexPathOverride: process.execPath, env: {} });
  assert.equal(codex.startThread({}).id, null);
  assert.equal(codex.resumeThread("12345678-1234-1234-1234-123456789abc", {}).id, "12345678-1234-1234-1234-123456789abc");
  await assert.rejects(loadSdk("relative.js"));
});
