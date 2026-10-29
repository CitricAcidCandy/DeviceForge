import type { ValidateFunction } from 'ajv';
import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose } from '../../plugin-sdk/models.ts';
import type {
  LocalPointContribution, PointAccess, PointCatalog, PointContribution, PointContributionInfo,
  PointDefinitionInfo, PointProvider, PointRef,
} from '../../plugin-sdk/points.ts';
import { compileServiceSchema } from '../extensions/service-schema.ts';
import { bindPointRelease } from './access.ts';
import type { PointOwner } from './access.ts';
import { checkContribution, checkDefinition, checkPointRef, current, pointKey, samePoint, snapshotJson } from './rules.ts';

interface Definition {
  readonly info: PointDefinitionInfo;
  readonly validator: ValidateFunction | null;
}
interface Contribution {
  value: PointContribution;
  readonly provider: PointProvider;
}

export function createPointRegistry() {
  const definitions = new Map<string, Definition>();
  const contributions = new Map<string, Contribution>();
  const selections = new Map<string, string>();
  const listeners = new Set<() => void>();
  const resources = new Set<Dispose>();
  let snapshot: PointCatalog | null = null;
  let local: readonly LocalPointContribution[] = [];
  let closed = false;
  function check() {
    if (closed) throw new HostError('cancelled', 'point_registry_closed', '扩展点注册表已关闭');
  }
  function invalidate() {
    snapshot = null;
    if (closed) return;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个观察者不能破坏目录或其他插件。 */ }
    }
  }
  function describe(entry: Contribution): LocalPointContribution {
    const value = entry.value;
    const definition = definitions.get(value.point.id);
    const mode = value.mode ?? 'append';
    let state: PointContributionInfo['state'] = 'active';
    let reason: PointContributionInfo['reason'] = null;
    if (!definition) { state = 'waiting'; reason = 'point_missing'; }
    else if (definition.info.version !== value.point.version) { state = 'version_mismatch'; reason = 'version_mismatch'; }
    else if (!definition.info.modes.includes(mode)) { state = 'invalid'; reason = 'mode_not_allowed'; }
    else if (definition.validator && !definition.validator(value.data)) { state = 'invalid'; reason = 'data_invalid'; }
    return Object.freeze({
      id: value.id, point: value.point, order: value.order ?? 0, mode, data: value.data,
      provider: entry.provider, state, reason,
      selected: state === 'active' && mode === 'replace' && selections.get(pointKey(value.point)) === value.id,
      ...('payload' in value ? { payload: value.payload } : {}),
    });
  }
  function catalog(): PointCatalog {
    check();
    if (snapshot) return snapshot;
    local = Object.freeze([...contributions.values()].map(describe)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en')));
    snapshot = Object.freeze({
      definitions: Object.freeze([...definitions.values()].map((entry) => entry.info)
        .sort((a, b) => a.id.localeCompare(b.id, 'en'))),
      contributions: Object.freeze(local.map(({ payload: _payload, ...entry }) => Object.freeze(entry))),
    });
    return snapshot;
  }
  function list(point: PointRef): readonly LocalPointContribution[] {
    checkPointRef(point);
    catalog();
    return Object.freeze(local.filter((entry) => samePoint(entry.point, point)));
  }
  function selected(point: PointRef): LocalPointContribution | null {
    return list(point).find((entry) => entry.selected) ?? null;
  }
  function select(point: PointRef, id: string | null): void {
    check();
    checkPointRef(point);
    const key = pointKey(point);
    if (id !== null) {
      const entry = list(point).find((item) => item.id === id);
      if (!entry || entry.state !== 'active') throw new Error('所选贡献不是当前可用项');
      if (entry.mode !== 'replace') throw new Error('只能显式选择替换贡献');
      if (!selections.has(key) && selections.size >= 2048) throw new Error('扩展点选择数量已达上限');
    }
    if ((selections.get(key) ?? null) === id) return;
    if (id === null) selections.delete(key);
    else selections.set(key, id);
    invalidate();
  }
  function bind(owner: PointOwner, cleanup: () => void): Dispose {
    let released = false;
    let tracked: Dispose | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (tracked) resources.delete(tracked);
      cleanup();
    };
    tracked = bindPointRelease(owner.signal, owner.track, release);
    if (!released) resources.add(tracked);
    return tracked;
  }
  function access(owner: PointOwner): PointAccess {
    if (!/^[a-z][a-z0-9._-]{0,99}$/.test(owner.pluginId) ||
        !Number.isSafeInteger(owner.generation) || owner.generation < 0)
      throw new Error('扩展点所属插件身份无效');
    const ensure = () => { check(); current(owner.signal); };
    const provider = Object.freeze({ pluginId: owner.pluginId, generation: owner.generation });
    return Object.freeze<PointAccess>({
      define(value) {
        ensure();
        checkDefinition(owner.pluginId, value);
        if (definitions.has(value.id) || contributions.has(value.id)) throw new Error('扩展点标识重复');
        if (definitions.size >= 512) throw new Error('扩展点数量已达上限');
        const schema = snapshotJson(value.inputSchema === undefined ? true : value.inputSchema);
        const validator = compileServiceSchema(schema);
        if (validator && '$async' in validator && validator.$async) throw new Error('扩展点 Schema 不支持异步校验');
        const entry: Definition = { validator, info: Object.freeze({
          id: value.id, version: value.version, title: value.title, inputSchema: schema,
          modes: Object.freeze([...(value.modes ?? ['append', 'replace'])]), provider,
        }) };
        definitions.set(value.id, entry);
        const release = bind(owner, () => {
          if (definitions.get(entry.info.id) !== entry) return;
          definitions.delete(entry.info.id);
          invalidate();
        });
        invalidate();
        return release;
      },
      contribute(value) {
        ensure();
        checkContribution(owner.pluginId, value);
        if (contributions.has(value.id) || definitions.has(value.id)) throw new Error('扩展点贡献标识重复');
        if (contributions.size >= 2048) throw new Error('扩展点贡献数量已达上限');
        const clone = (next: PointContribution): PointContribution => Object.freeze({
          id: next.id, point: Object.freeze({ ...next.point }), data: snapshotJson(next.data),
          ...(next.order !== undefined ? { order: next.order } : {}),
          ...(next.mode !== undefined ? { mode: next.mode } : {}),
          ...('payload' in next ? { payload: next.payload } : {}),
        });
        const entry: Contribution = { value: clone(value), provider };
        const id = entry.value.id;
        contributions.set(id, entry);
        const dispose = bind(owner, () => {
          if (contributions.get(id) !== entry) return;
          contributions.delete(id);
          invalidate();
        });
        invalidate();
        return {
          update(next) {
            ensure();
            if (contributions.get(id) !== entry) throw new Error('扩展点贡献已撤销');
            if (next.id !== id) throw new Error('更新不能更改贡献标识');
            checkContribution(owner.pluginId, next);
            entry.value = clone(next);
            invalidate();
          },
          dispose,
        };
      },
      catalog() { ensure(); return catalog(); },
      list(point) { ensure(); return list(point); },
      selected(point) { ensure(); return selected(point); },
      select(point, id) { ensure(); select(point, id); },
      subscribe(listener) {
        ensure();
        const guarded = () => { if (!owner.signal.aborted) listener(); };
        listeners.add(guarded);
        return bind(owner, () => { listeners.delete(guarded); });
      },
    });
  }
  return {
    access, catalog, list, selected, select,
    /** 宿主只读目录也通过相同访问层；命名空间写入仍限定为 host.*。 */
    hostAccess(signal: AbortSignal, track: PointOwner['track']) {
      return access({ pluginId: 'host', generation: 0, signal, track });
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const release of [...resources]) release();
      definitions.clear();
      contributions.clear();
      selections.clear();
      listeners.clear();
      snapshot = null;
      local = [];
    },
  };
}
export type PointRegistry = ReturnType<typeof createPointRegistry>;
