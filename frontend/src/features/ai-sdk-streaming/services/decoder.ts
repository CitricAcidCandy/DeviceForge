import { isSessionBytes, normalizeSessionId } from '../../../services/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/values.ts';
import { copyFrozen, decodeResult, invalidStream, utf8Length, validUnicode } from '../utils/rules.ts';
import type { AiSdkItemKind, AiSdkObservedEvent, AiSdkObservedItem, AiSdkStreamChunk, AiSdkStreamEvent, AiSdkStreamItem, AiSdkStreamView } from '../types/index.ts';

const kinds: readonly AiSdkItemKind[] = ['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list'];
function itemKind(value: unknown): value is AiSdkItemKind { return kinds.some((kind) => kind === value); }
function decodeEvent(value: unknown, logId: string | null): AiSdkStreamEvent {
  if (!jsonObject(value) || value.format_version !== 1) throw invalidStream(logId);
  if (value.type === 'thread.started') {
    if (!onlyKeys(value, ['format_version', 'type', 'thread_id']) || typeof value.thread_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.thread_id)) throw invalidStream(logId);
    return Object.freeze({ format_version: 1, type: value.type, thread_id: value.thread_id });
  }
  if (value.type === 'turn.started' || value.type === 'turn.completed') {
    if (!onlyKeys(value, ['format_version', 'type'])) throw invalidStream(logId);
    return Object.freeze({ format_version: 1, type: value.type });
  }
  if (value.type !== 'item.started' && value.type !== 'item.updated' && value.type !== 'item.completed') throw invalidStream(logId);
  const item = value.item;
  if (!onlyKeys(value, ['format_version', 'type', 'item']) || !jsonObject(item) || !onlyKeys(item, ['id', 'type', 'status', 'text'])
    || typeof item.id !== 'string' || !/^item_[1-9][0-9]{0,4}$/.test(item.id) || !itemKind(item.type)
    || Object.hasOwn(item, 'status') && item.status !== 'in_progress' && item.status !== 'completed' && item.status !== 'failed'
    || Object.hasOwn(item, 'text') && (item.type !== 'agent_message' && item.type !== 'reasoning' || typeof item.text !== 'string')
    || typeof item.text === 'string' && (!validUnicode(item.text) || utf8Length(item.text) > 512 * 1024)
    || value.type === 'item.completed' && item.type === 'agent_message' && typeof item.text !== 'string') throw invalidStream(logId);
  const decoded: AiSdkStreamItem = Object.freeze({ id: item.id, type: item.type,
    ...(item.status === 'in_progress' || item.status === 'completed' || item.status === 'failed' ? { status: item.status } : {}),
    ...(typeof item.text === 'string' ? { text: item.text } : {}),
  });
  return Object.freeze({ format_version: 1, type: value.type, item: decoded });
}

export class AiSdkStreamDecoder {
  private cursor = 0;
  private bytes = 0;
  private pending: number[] = [];
  private firstSequence = 0;
  private chunks: AiSdkStreamChunk[] = [];
  private events: AiSdkObservedEvent[] = [];
  private items = new Map<string, AiSdkObservedItem>();
  private threadId: string | null;
  private threadSeen = false;
  private started = false;
  private turnCompleted = false;
  private text = '';
  private answerCount = 0;
  private readonly newThread: boolean;
  constructor(expectedThreadId: string | null, newThread = false) {
    this.threadId = expectedThreadId === null ? null : normalizeSessionId(expectedThreadId);
    this.newThread = newThread;
  }
  fork(): AiSdkStreamDecoder {
    const copied = new AiSdkStreamDecoder(this.threadId, this.newThread);
    copied.cursor = this.cursor; copied.bytes = this.bytes;
    copied.pending = this.pending.slice(); copied.firstSequence = this.firstSequence;
    copied.chunks = this.chunks.slice(); copied.events = this.events.slice(); copied.items = new Map(this.items);
    copied.threadSeen = this.threadSeen; copied.started = this.started;
    copied.turnCompleted = this.turnCompleted; copied.text = this.text; copied.answerCount = this.answerCount;
    return copied;
  }
  append(chunk: AiSdkStreamChunk, logId: string | null): void {
    if (!naturalNumber(chunk.sequence) || chunk.sequence !== this.cursor + 1 || chunk.sequence > 65536 || chunk.stream !== 'stdout'
      || !isSessionBytes(chunk.bytes) || this.bytes + chunk.bytes.length > 4 * 1024 * 1024) throw invalidStream(logId);
    this.bytes += chunk.bytes.length;
    for (const byte of chunk.bytes) {
      if (this.pending.length === 0) this.firstSequence = chunk.sequence;
      if (byte === 10) {
        if (this.pending.length + 1 > 512 * 1024) throw invalidStream(logId);
        this.line(chunk.sequence, logId); this.pending = [];
      } else {
        if (this.pending.length >= 512 * 1024 - 1) throw invalidStream(logId);
        this.pending.push(byte);
      }
    }
    this.chunks.push(copyFrozen(chunk)); this.cursor = chunk.sequence;
  }
  discardTail(): void { this.pending = []; this.firstSequence = 0; }
  snapshot(): AiSdkStreamView {
    return Object.freeze({ cursor: this.cursor, chunks: Object.freeze(this.chunks.slice()), events: Object.freeze(this.events.slice()),
      items: Object.freeze(Array.from(this.items.values())), threadId: this.threadId, text: this.text,
      turnCompleted: this.turnCompleted, pendingBytes: this.pending.length });
  }
  complete(value: unknown, projectId: string, logId: string | null) {
    if (this.pending.length > 0 || !this.turnCompleted || !this.started || !this.threadSeen || this.threadId === null) throw invalidStream(logId);
    return decodeResult(value, projectId, this.threadId, this.text, this.newThread, logId);
  }
  private line(sequence: number, logId: string | null): void {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(this.pending))); }
    catch { throw invalidStream(logId); }
    if (this.turnCompleted || this.events.length >= 10000) throw invalidStream(logId);
    const event = decodeEvent(parsed, logId);
    if (event.type === 'thread.started') {
      if (this.threadSeen || this.started || this.threadId !== null && this.threadId !== event.thread_id) throw invalidStream(logId);
      this.threadId = event.thread_id; this.threadSeen = true;
    } else if (event.type === 'turn.started') {
      if (this.started || !this.threadSeen) throw invalidStream(logId);
      this.started = true;
    } else if (event.type === 'turn.completed') {
      if (!this.started || Array.from(this.items.values()).some((item) => !item.completed)) throw invalidStream(logId);
      this.turnCompleted = true;
    } else {
      if (!this.started) throw invalidStream(logId);
      const previous = this.items.get(event.item.id);
      if (previous?.completed || previous !== undefined && previous.item.type !== event.item.type
        || previous === undefined && event.item.id !== `item_${this.items.size + 1}`) throw invalidStream(logId);
      const completed = event.type === 'item.completed';
      if (completed && event.item.type === 'agent_message') {
        const text = event.item.text;
        if (text === undefined) throw invalidStream(logId);
        const answer = this.answerCount === 0 ? text : `${this.text}\n${text}`;
        if (utf8Length(answer) > 512 * 1024) throw invalidStream(logId);
        this.text = answer; this.answerCount++;
      }
      this.items.set(event.item.id, Object.freeze({ sequence, completed, item: event.item }));
    }
    this.events.push(Object.freeze({ firstSequence: this.firstSequence, sequence, event }));
  }
}
