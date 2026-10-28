import type { JsonValue } from '../../plugin-sdk/index.ts';
import type { LocalDebuggerOptions, ResolvedTarget } from './types.ts';
import { bounded, fail, json, keys, object, text } from './validation.ts';

function hostResult(value: unknown, includeResult: boolean): JsonValue {
  const result = object(value);
  keys(result, ['data', 'logId']);
  const payload = Object.getOwnPropertyDescriptor(result, 'data');
  const log = Object.getOwnPropertyDescriptor(result, 'logId');
  if (!payload || !log || !('value' in payload) || !('value' in log))
    return fail('invalid_result', '原HostResult必须提供无访问器的data和logId字段');
  const data: unknown = payload.value;
  const logId: unknown = log.value;
  if (logId !== null && (typeof logId !== 'string' || logId.length > 256))
    return fail('invalid_result', '原HostResult缺少合法日志ID字段');
  // 缺省只识别顶层类型，不遍历原子结果，避免复制大载荷或读取任意返回字段。
  return includeResult ? { data: json(data, true), logId } : { data: null, logId,
    result_metadata: { included: false, type: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
      bytes: null, reason: '未复制或遍历原子试调用结果；显式include_result才读取脱敏JSON' } };
}

export function ownedCatalog(options: LocalDebuggerOptions, target: ResolvedTarget) {
  const catalog = options.extensions.catalog();
  const current = (entry: { pluginId: string; generation: number }) =>
    entry.pluginId === target.plugin_id && String(entry.generation) === target.generation;
  return {
    components: catalog.components.filter(current), modules: catalog.modules.filter(current),
    commands: catalog.commands.filter(current).map((entry) => ({ ...entry, schema_status: 'missing' })),
    services: catalog.services.filter(current).map((entry) => ({ ...entry,
      schema_status: entry.inputSchema === true || entry.outputSchema === true ? 'unconstrained_or_missing' : 'declared',
    })),
  };
}

export async function invoke(options: LocalDebuggerOptions, target: ResolvedTarget, input: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
  keys(input, ['kind', 'id', 'version', 'input', 'confirmed', 'allow_unknown_side_effects', 'include_result']);
  if (input.include_result !== undefined && typeof input.include_result !== 'boolean')
    return fail('invalid_parameters', 'include_result必须是布尔值');
  if (input.confirmed !== true || input.allow_unknown_side_effects !== true)
    return fail('confirmation_required', '试调用可能间接影响设备，必须显式确认并允许未知副作用；调试器不会自动试调用');
  const id = text(input.id, '调用标识');
  const payload = json(input.input);
  const catalog = ownedCatalog(options, target);
  const current = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  if (input.kind === 'command') {
    if (input.version !== undefined) return fail('invalid_parameters', '浏览器命令没有版本字段');
    if (!catalog.commands.some((entry) => entry.id === id))
      return fail('target_mismatch', '当前命令目录不属于所选插件及代次');
    return hostResult(await bounded(() => options.extensions.executeCommand(id, payload, current), current, true), input.include_result === true);
  }
  if (input.kind === 'service') {
    const version = text(input.version, '服务精确版本');
    if (!catalog.services.some((entry) => entry.id === id && entry.version === version && entry.available))
      return fail('target_mismatch', '当前服务目录不属于所选插件、代次或精确版本');
    return hostResult(await bounded(() => options.extensions.callService(id, version, payload, current), current, true), input.include_result === true);
  }
  return fail('capability_unavailable', '只支持显式调用当前插件的浏览器命令或服务，不调用设备入口');
}

export async function reload(options: LocalDebuggerOptions, target: ResolvedTarget, input: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
  keys(input, ['confirmed']);
  if (input.confirmed !== true) return fail('confirmation_required', '重载运行实例需要显式确认');
  const manager = options.manager();
  const current = () => manager.diagnosticSnapshot().find((entry) => entry.id === target.plugin_id);
  if (String(current()?.generation) !== target.generation) return fail('stale_generation', '重载目标已换代');
  // 与后端reload_timeout保持一致；卸载和加载共享截止点，不各自追加等待。
  const timeoutMs = 30000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const wait = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (options.reloadPlugin) {
    // 构建修订与整套组件归属由共同安装入口处理；本层只委托一次，不预先卸载。
    const reloadPlugin = options.reloadPlugin;
    const result = object(json(await bounded(() => reloadPlugin(target, wait), wait, true, remaining()), true));
    wait.throwIfAborted();
    const latest = current();
    if (!latest || latest.generation === Number(target.generation) ||
        result.plugin_id !== latest.id || result.generation !== String(latest.generation) || result.status !== 'loaded' ||
        typeof result.scope !== 'string' || !result.scope.trim())
      return fail('result_unconfirmed', '重载回执没有对应实际新运行代次，不能把旧入口或旧构建宣称为成功');
    return json(result, true);
  }
  await bounded(() => manager.unload(target.plugin_id), wait, true, remaining());
  wait.throwIfAborted();
  if (current()) return fail('result_unconfirmed', '卸载后仍有运行实例，不继续加载或重放');
  const result = await bounded(() => manager.load(target.plugin_id), wait, true, remaining());
  if (String(current()?.generation) !== String(result.generation) || String(result.generation) === target.generation)
    return fail('result_unconfirmed', '运行实例重载没有得到实际新代次');
  return json({ status: 'loaded', plugin_id: result.id, generation: String(result.generation),
    state: result.state, scope: 'browser-runtime-only', installation_changed: false });
}
