import { HostError } from '../../plugin-sdk/index.ts';
import type { JsonValue } from '../../plugin-sdk/index.ts';
import { bounded, fail, json } from '../debugger-local/validation.ts';
import { mutationTools, parsePlan } from './parameters.ts';
import { bindParameters, bindingEvidence, logId, publicError, publicEvidence, resultState } from './evidence.ts';
import type { BindingEvidence, StepState } from './evidence.ts';

interface Target { readonly plugin_id: string; readonly generation: string | null }
type Execute = (tool: string, target: Target, parameters: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
interface Limits { readonly totalMs?: number; readonly stepMs?: number }

function budget(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    return fail('invalid_parameters', '自动调试预算必须为正整数且不超过宿主上限');
  return result;
}

// 自动调试消费同一本地执行端口；不另建任务系统、不重放动作，给桥的30秒期限保留收尾时间。
export async function runDebuggerAutomation(parameters: JsonValue, target: Target, signal: AbortSignal,
  execute: Execute, limits: Limits = {}): Promise<JsonValue> {
  const plan = parsePlan(parameters);
  const totalMs = budget(limits.totalMs, 28000), stepMs = budget(limits.stepMs, 10000);
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), totalMs);
  const current = AbortSignal.any([signal, lifetime.signal]);
  const bindings = new Map<string, BindingEvidence>();
  const steps: JsonValue[] = [];
  const started = performance.now();
  let status: 'completed' | 'failed' | 'indeterminate' | 'cancelled' = 'completed';
  let stopped = false, unverifiedUi = false, otherMutation = false, assertions = 0;
  let evidenceBytes = 0;
  try {
    for (const step of plan.steps) {
      const base = { id: step.id, tool: step.tool, target_generation: target.generation };
      if (stopped || current.aborted) {
        if (!stopped) status = signal.aborted ? 'cancelled' : 'indeterminate';
        stopped = true;
        steps.push({ ...base, status: 'skipped', result: null, error: null, log_id: null,
          result_metadata: { included: false, bytes: 0, reason: '计划已停止，未派发此步骤' } });
        continue;
      }
      const begin = performance.now();
      const mutation = mutationTools.has(step.tool);
      let state: StepState = 'succeeded';
      let result: JsonValue = null;
      let error: { code: string; message: string } | null = null;
      let stepLogId: string | null = null;
      let stepExpired = false;
      let bytes = 0, included = false;
      try {
        const resolved = bindParameters(step, bindings);
        const remaining = Math.max(1, Math.min(stepMs, totalMs - (performance.now() - started)));
        const stepLifetime = new AbortController();
        const stepTimer = setTimeout(() => { stepExpired = true; stepLifetime.abort(); }, remaining);
        const stepSignal = AbortSignal.any([current, stepLifetime.signal]);
        let raw: JsonValue;
        try { raw = json(await bounded(() => execute(step.tool, target, resolved, stepSignal), stepSignal, mutation, remaining)); }
        finally { clearTimeout(stepTimer); }
        current.throwIfAborted();
        state = resultState(raw);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) stepLogId = logId(raw.logId ?? raw.log_id);
        if (state === 'succeeded') bindings.set(step.id, bindingEvidence(step.tool, raw, resolved));
        const evidence = publicEvidence(raw);
        bytes = new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
        included = bytes <= 16384 && evidenceBytes + bytes <= 768 * 1024;
        if (included) { result = evidence; evidenceBytes += bytes; }
        if (mutation) {
          if (step.tool === 'ui_action') unverifiedUi = true;
          else otherMutation = true;
        }
        if (step.tool === 'ui_assert' && state === 'succeeded') {
          if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.status === 'passed') {
            assertions++; unverifiedUi = false;
          } else state = 'indeterminate';
        }
      } catch (caught) {
        error = publicError(caught);
        if (caught instanceof HostError) stepLogId = logId(caught.logId);
        const definite = caught instanceof HostError &&
          /debugger_(invalid_parameters|confirmation_required|binding_unavailable|revision_conflict|data_conflict|stale_generation|target_not_selected|capability_unavailable)/.test(caught.code);
        state = stepExpired ? 'indeterminate' : current.aborted ? mutation ? 'indeterminate' : signal.aborted ? 'cancelled' : 'indeterminate'
          : mutation && !definite ? 'indeterminate' : caught instanceof HostError && caught.code === 'debugger_timeout' ? 'indeterminate' : 'failed';
      }
      steps.push({ ...base, status: state, result, error, log_id: stepLogId,
        elapsed_ms: Math.max(0, Math.round(performance.now() - begin)),
        business_outcome: mutation ? 'unknown' : null,
        result_metadata: { included, bytes, reason: included ? null : '结果未取得或超过单步16KiB／总768KiB证据预算' } });
      if (state === 'indeterminate' || state === 'cancelled') {
        status = state; stopped = true;
      } else if (state === 'failed') {
        status = 'failed'; stopped = plan.stopOnFailure;
      }
    }
    return json({ status, target_generation: target.generation, steps,
      verified: status === 'completed' && assertions > 0 && !unverifiedUi && !otherMutation,
      assertions_passed: assertions, business_outcome: '仅由显式断言验证对应界面检查点；派发和保存不代表完整业务成功',
      elapsed_ms: Math.max(0, Math.round(performance.now() - started)), replayed: false });
  } finally { clearTimeout(timer); lifetime.abort(); }
}
