import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, HostEvent, JsonValue } from '../../plugin-sdk/index.ts';

export function createExtensionBus() {
  const events = new Map<string, Set<(event: HostEvent) => void>>();
  const states = new Map<string, Map<string, JsonValue>>();
  const observers = new Map<string, Map<string, Set<(value: JsonValue) => void>>>();
  function namespace(owner: string, name: string) {
    if (!name.startsWith(`${owner}.`) || !/^[a-z][a-z0-9._-]{0,199}$/.test(name)) throw new HostError('protocol', 'invalid_namespace', '事件或状态标识超出所属命名空间');
  }
  return {
    subscribeEvent(name: string, listener: (event: HostEvent) => void): Dispose {
      if (!/^[a-z][a-z0-9._-]{0,199}$/.test(name)) throw new Error('事件标识无效');
      let set = events.get(name);
      if (!set) { set = new Set(); events.set(name, set); }
      set.add(listener);
      return () => { set.delete(listener); if (!set.size) events.delete(name); };
    },
    emit(owner: string, generation: number, name: string, data: JsonValue) {
      namespace(owner, name);
      const event: HostEvent = { name, data, pluginId: owner, generation };
      for (const listener of events.get(name) ?? []) { try { listener(event); } catch { /* 订阅失败不影响其他消费者。 */ } }
    },
    get(owner: string, key: string) { namespace(owner, key); return states.get(owner)?.get(key); },
    set(owner: string, key: string, value: JsonValue) {
      namespace(owner, key);
      let values = states.get(owner); if (!values) { values = new Map(); states.set(owner, values); }
      values.set(key, value);
      for (const listener of observers.get(owner)?.get(key) ?? []) { try { listener(value); } catch { /* 状态订阅互相隔离。 */ } }
    },
    subscribeState(owner: string, key: string, listener: (value: JsonValue) => void): Dispose {
      namespace(owner, key);
      let keys = observers.get(owner); if (!keys) { keys = new Map(); observers.set(owner, keys); }
      let set = keys.get(key); if (!set) { set = new Set(); keys.set(key, set); }
      set.add(listener);
      return () => { set.delete(listener); if (!set.size) keys.delete(key); if (!keys.size) observers.delete(owner); };
    },
    clearOwner(owner: string) { states.delete(owner); observers.delete(owner); },
    clear() { events.clear(); states.clear(); observers.clear(); },
  };
}
