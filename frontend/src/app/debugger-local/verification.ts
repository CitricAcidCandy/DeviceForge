import type { JsonValue } from '../../plugin-sdk/index.ts';
import type { DebugActionVerification, TreeAssertion, TreeAssertionResult } from '../../plugins/debugger/index.ts';
import { isDataSecretKey } from '../../plugins/debugger/index.ts';
import type { UiActionExpectation } from './ui-parameters.ts';
import { json } from './validation.ts';

export interface VerificationPorts {
  readonly assert?: (assertion: TreeAssertion) => TreeAssertionResult;
  readonly readData?: (sourceId: string, query: JsonValue | undefined, signal: AbortSignal) => Promise<JsonValue>;
}

function equal(actual: JsonValue, expected: JsonValue): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual)) return Array.isArray(expected) && actual.length === expected.length &&
    actual.every((value, index) => expected[index] !== undefined && equal(value, expected[index]));
  if (Array.isArray(expected)) return false;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) =>
    Object.hasOwn(expected, key) && actual[key] !== undefined && expected[key] !== undefined && equal(actual[key], expected[key]));
}
function redacted(value: JsonValue): boolean {
  if (typeof value === 'string') return value.includes('[已脱敏]');
  if (Array.isArray(value)) return value.some(redacted);
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) => isDataSecretKey(key) || redacted(child));
}
function atPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  let current = value;
  if (!pointer) return current;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (isDataSecretKey(key) || current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    current = json(descriptor.value);
  }
  return current;
}
function observe<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', abort); };
    const abort = () => { stop(); resolve(undefined); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => signal.aborted ? undefined : operation()).then(
      (value) => { stop(); resolve(value); }, (error: unknown) => { stop(); reject(error); },
    );
  });
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

// 所有尝试共享原调用信号和一次检查预算，等待只读公开证据，不重新执行动作。
export async function verifyAction(expectation: UiActionExpectation, ports: VerificationPorts,
  caller: AbortSignal): Promise<DebugActionVerification> {
  const scope = expectation.kind === 'data' ? 'business' : 'ui';
  const reply = (status: DebugActionVerification['status'], reason: string): DebugActionVerification => ({ status, scope, reason });
  if (caller.aborted) return reply('timed_out', '原调用预算或所属等待已结束，动作不重放');
  if (expectation.kind === 'ui' && !ports.assert) return reply('unavailable', '没有本次动作所属挂载根的公开界面断言端口');
  if (expectation.kind === 'data' && !ports.readData) return reply('unavailable', '没有装配已登记数据源的只读端口，业务结果未知');
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), expectation.timeout_ms);
  const signal = AbortSignal.any([caller, lifetime.signal]);
  const deadline = performance.now() + expectation.timeout_ms;
  try {
    do {
      if (signal.aborted) break;
      if (expectation.kind === 'ui') {
        const result = ports.assert?.(expectation.assertion);
        if (!result || result.status === 'indeterminate') return reply('unavailable', '界面查询不唯一、不完整或缺少可读取状态，结果无法确认');
        if (!signal.aborted && result.status === 'passed') return reply('passed', '本步骤声明的界面检查点满足期望；不证明完整业务成功');
      } else {
        const readData = ports.readData;
        if (!readData) return reply('unavailable', '没有装配已登记数据源的只读端口，业务结果未知');
        const raw = await observe(() => readData(expectation.source_id, expectation.query, signal), signal);
        if (signal.aborted || raw === undefined) break;
        const result = json(raw);
        if (result === null || typeof result !== 'object' || Array.isArray(result) ||
            result.source_id !== expectation.source_id || result.value === undefined)
          return reply('unavailable', '公开数据源没有返回本次目标的业务投影，结果未知');
        let matched = true;
        for (const check of expectation.checks) {
          const actual = atPointer(result.value, check.pointer);
          if (actual === undefined || redacted(actual) || redacted(check.equals))
            return reply('unavailable', '检查字段缺失、敏感或已脱敏，不能确认业务结果');
          if (!equal(actual, check.equals)) matched = false;
        }
        if (matched) return reply('passed', '本步骤声明的公开数据检查点满足期望；未返回原始字段值');
      }
      if (performance.now() >= deadline) break;
      await pause(Math.min(50, Math.max(0, deadline - performance.now())), signal);
    } while (!signal.aborted);
    return reply('timed_out', caller.aborted ? '原调用预算或所属等待已结束，动作不重放' : '本步骤检查在预算内未满足期望，动作不重放');
  } catch {
    return reply(signal.aborted ? 'timed_out' : 'unavailable', signal.aborted
      ? '原调用或检查等待已结束，动作不重放' : '已登记的公开证据不可读取，不能确认业务结果');
  } finally { clearTimeout(timer); lifetime.abort(); }
}
