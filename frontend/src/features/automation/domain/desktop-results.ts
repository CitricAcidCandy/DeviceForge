import { decodeArtifactEnvelope, decodeEmptyArtifactResult, invalidBusinessResult, isJsonData, jsonObject, naturalNumber, onlyKeys, requireArtifactNames } from '../../../shared/jobs/index.ts';
import type { ArtifactEnvelope, PublishedResult } from '../../../shared/jobs/index.ts';
import { int32 } from './desktop-rules.ts';
import { frozenAutomationCopy } from './rules.ts';
import type { DesktopClick, DesktopClickResult, DesktopPositionResult, DesktopRepeat, DesktopRepeatResult, InputTracePlayed, InputTracePlayback, InputTraceRecord, InputTraceRecorded } from './desktop-types.ts';

export function decodeDesktopPosition(raw: unknown, logId: string | null): DesktopPositionResult {
  const value = decodeEmptyArtifactResult(raw, 'Windows 鼠标', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['x', 'y', 'coordinate_space', 'source']) || !int32(value.x) || !int32(value.y)
    || value.coordinate_space !== 'virtual_desktop' || value.source !== 'GetCursorPos') throw invalidBusinessResult('Windows 鼠标', logId);
  return Object.freeze({ x: value.x, y: value.y, coordinate_space: 'virtual_desktop', source: 'GetCursorPos' });
}
export function decodeDesktopClick(raw: unknown, logId: string | null, input: DesktopClick): DesktopClickResult {
  const value = decodeEmptyArtifactResult(raw, 'Windows 鼠标', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['dispatched', 'button', 'click', 'position', 'effect_confirmed'])
    || value.dispatched !== 1 || value.button !== input.button || value.click !== input.click || value.effect_confirmed !== false
    || !jsonObject(value.position) || !onlyKeys(value.position, ['x', 'y']) || !int32(value.position.x) || !int32(value.position.y)) throw invalidBusinessResult('Windows 鼠标', logId);
  return frozenAutomationCopy({ dispatched: 1, button: input.button, click: input.click, effect_confirmed: false, position: { x: value.position.x, y: value.position.y } });
}
export function decodeDesktopRepeat(raw: unknown, logId: string | null, input: DesktopRepeat): DesktopRepeatResult {
  const value = decodeEmptyArtifactResult(raw, 'Windows 鼠标', logId);
  if (!jsonObject(value) || !onlyKeys(value, ['dispatched', 'stop_reason', 'button', 'click', 'position', 'elapsed_ms', 'effect_confirmed'])
    || !naturalNumber(value.dispatched) || !['count_limit', 'duration', 'manual_limit', 'f9'].some((reason) => reason === value.stop_reason) || value.effect_confirmed !== false
    || value.button !== input.button || value.click !== input.click || !jsonObject(value.position) || !onlyKeys(value.position, ['x', 'y']) || !int32(value.position.x) || !int32(value.position.y) || !naturalNumber(value.elapsed_ms)
    || value.stop_reason === 'count_limit' && (input.repeat.kind !== 'count' || value.dispatched !== input.repeat.count)
    || value.stop_reason === 'duration' && input.repeat.kind !== 'duration' || value.stop_reason === 'manual_limit' && input.repeat.kind !== 'manual' || value.stop_reason === 'f9' && input.stop_on_f9 === false
    || input.repeat.kind === 'count' && value.dispatched > input.repeat.count) throw invalidBusinessResult('Windows 鼠标', logId);
  if (value.stop_reason !== 'count_limit' && value.stop_reason !== 'duration' && value.stop_reason !== 'manual_limit' && value.stop_reason !== 'f9') throw invalidBusinessResult('Windows 鼠标', logId);
  return frozenAutomationCopy({ dispatched: value.dispatched, stop_reason: value.stop_reason, button: input.button, click: input.click, position: { x: value.position.x, y: value.position.y }, elapsed_ms: value.elapsed_ms, effect_confirmed: false });
}
export function decodeInputTraceArtifacts(raw: unknown, logId: string | null, recorded?: boolean): ArtifactEnvelope {
  const envelope = decodeArtifactEnvelope(raw, '输入轨迹', logId);
  const recording = recorded ?? envelope.artifacts.some((artifact) => artifact.filename === 'recording.msgpack');
  requireArtifactNames(envelope, recording ? ['recording.msgpack', 'operation.json', 'input-trace.log'] : ['operation.json', 'input-trace.log'], '输入轨迹', logId);
  if (!isJsonData(envelope.result) || envelope.artifacts.some((artifact) => artifact.size > 64 * 1024 * 1024)) throw invalidBusinessResult('输入轨迹', logId);
  return frozenAutomationCopy(envelope);
}
export function decodeInputTraceRecord(raw: unknown, logId: string | null, input: InputTraceRecord): PublishedResult<InputTraceRecorded> {
  const envelope = decodeInputTraceArtifacts(raw, logId, true);
  const value = envelope.result;
  if (!jsonObject(value) || !onlyKeys(value, ['recorded', 'event_type', 'duration_ms', 'events', 'stop', 'format', 'effect_confirmed'])
    || value.recorded !== true || value.event_type !== input.event_type || value.duration_ms !== input.duration_ms || !naturalNumber(value.events) || value.events < 1 || value.events > 100000
    || value.stop !== 'stdin_exit' || value.format !== 'input_trace.msgpack.v1' || value.effect_confirmed !== false) throw invalidBusinessResult('输入轨迹', logId);
  return frozenAutomationCopy({ result: { recorded: true, event_type: input.event_type, duration_ms: input.duration_ms, events: value.events, stop: 'stdin_exit', format: 'input_trace.msgpack.v1', effect_confirmed: false }, artifacts: envelope.artifacts });
}
export function decodeInputTracePlayback(raw: unknown, logId: string | null, input: InputTracePlayback): PublishedResult<InputTracePlayed> {
  const envelope = decodeInputTraceArtifacts(raw, logId, false);
  const value = envelope.result;
  if (!jsonObject(value) || !onlyKeys(value, ['completed', 'event_type', 'events', 'format', 'effect_confirmed'])
    || value.completed !== true || value.event_type !== input.event_type || !naturalNumber(value.events) || value.events < 1 || value.events > 100000
    || value.format !== 'input_trace.msgpack.v1' || value.effect_confirmed !== false) throw invalidBusinessResult('输入轨迹', logId);
  return frozenAutomationCopy({ result: { completed: true, event_type: input.event_type, events: value.events, format: 'input_trace.msgpack.v1', effect_confirmed: false }, artifacts: envelope.artifacts });
}
