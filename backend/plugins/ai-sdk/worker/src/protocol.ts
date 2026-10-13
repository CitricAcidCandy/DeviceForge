import { Socket } from "node:net";

export const FRAME_LIMIT = 64 * 1024;
export const CHUNK_LIMIT = 8192;
export const QUEUE_LIMIT = 32;
export const PROFILE = "codex_sdk_ts_0_162_1_node24";
export const SDK_VERSION = "0.162.1";
export type Role = "worker" | "proxy" | "coordinator";
export type Payload = Record<string, unknown>;
export type Identity = { call_id: string; nonce: string };
export type Envelope = Identity & { format_version: 1; role: Role; sequence: number; payload: Payload };

export function object(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decode(bytes: Buffer, identity: Identity, role: Role, sequence: number): Payload {
  if (bytes.length > FRAME_LIMIT || bytes.at(-1) !== 10) throw new Error("私有帧不完整或超限");
  const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(frame) || Object.keys(frame).sort().join(",") !== "call_id,format_version,nonce,payload,role,sequence"
      || frame.format_version !== 1 || frame.call_id !== identity.call_id || frame.nonce !== identity.nonce
      || frame.role !== role || frame.sequence !== sequence || !object(frame.payload)) {
    throw new Error("私有帧身份、角色或序号不匹配");
  }
  return frame.payload;
}

export function block(payload: Payload): Buffer {
  if (!Array.isArray(payload.bytes) || payload.bytes.length > CHUNK_LIMIT
      || !payload.bytes.every((value: unknown) => Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 255)) {
    throw new Error("私有字节块无效或超限");
  }
  return Buffer.from(payload.bytes as number[]);
}

export class Channel {
  private readonly socket: Socket;
  private readonly identity: Identity;
  private readonly role: Role;
  private sent = 0;
  private received = 0;
  private buffered = Buffer.alloc(0);
  private readonly queue: Payload[] = [];
  private waiting: { resolve: (value: Payload | undefined) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  private ended = false;
  private pendingWrites = 0;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(socket: Socket, identity: Identity, role: Role) {
    this.socket = socket;
    this.identity = identity;
    this.role = role;
    socket.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); } catch { this.fail(new Error("私有传输输入无效")); }
    });
    socket.on("error", () => this.fail(new Error("私有传输连接失败")));
    socket.on("end", () => {
      if (this.buffered.length !== 0) this.fail(new Error("私有帧EOF前不完整"));
      this.ended = true;
      this.waiting?.resolve(undefined);
      this.waiting = undefined;
    });
    socket.on("close", () => {
      this.ended = true;
      this.waiting?.resolve(undefined);
      this.waiting = undefined;
    });
  }

  private receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (part.length > FRAME_LIMIT - this.buffered.length) throw new Error("私有帧超过64KiB");
      this.buffered = Buffer.concat([this.buffered, part]);
      offset = end;
      if (newline < 0) continue;
      if (this.received === 0xffff_ffff) throw new Error("私有接收序号已耗尽");
      const payload = decode(this.buffered, this.identity, "coordinator", this.received + 1);
      this.received += 1;
      this.buffered = Buffer.alloc(0);
      if (this.waiting) {
        this.waiting.resolve(payload);
        this.waiting = undefined;
      } else {
        if (this.queue.length >= QUEUE_LIMIT) throw new Error("私有输入队列已满");
        this.queue.push(payload);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
    this.socket.destroy();
  }

  async next(): Promise<Payload | undefined> {
    if (this.failure) throw this.failure;
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.ended) return undefined;
    if (this.waiting) throw new Error("私有输入不允许并行读取");
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  async send(payload: Payload): Promise<void> {
    if (this.failure || this.ended || this.pendingWrites >= QUEUE_LIMIT || this.sent === 0xffff_ffff) {
      throw new Error("私有发送不可用或队列已满");
    }
    const bytes = Buffer.from(JSON.stringify({
      format_version: 1, ...this.identity, role: this.role, sequence: this.sent + 1, payload,
    }) + "\n");
    if (bytes.length > FRAME_LIMIT) throw new Error("私有发送帧超过64KiB");
    this.sent += 1;
    this.pendingWrites += 1;
    const write = this.writeTail.then(() => new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (error) => error ? reject(new Error("私有发送失败")) : resolve());
    }));
    this.writeTail = write.catch(() => undefined);
    try { await write; } finally { this.pendingWrites -= 1; }
  }

  async sendBytes(kind: string, bytes: Buffer): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT) {
      await this.send({ kind, bytes: Array.from(bytes.subarray(offset, offset + CHUNK_LIMIT)) });
    }
  }

  async finish(): Promise<void> {
    await this.writeTail;
    await new Promise<void>((resolve) => this.socket.end(resolve));
  }

  destroy(): void { this.socket.destroy(); }
}
