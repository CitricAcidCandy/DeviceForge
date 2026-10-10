// 仅观察公开上下文与释放调用；缺省兼容路径显式省略 devices，不伪造响应或错误。
export function createObservedImporter({ browserId, observations, omitDevices = false }) {
  return async (url, signal) => {
    signal.throwIfAborted();
    const module = await import(url);
    signal.throwIfAborted();
    if (module.default?.id !== browserId) return module;
    const plugin = module.default;
    return { default: { ...plugin, async activate(context) {
      const record = { url, omitDevices, signal: context.signal, disposed: false,
        subscriptions: { operations: 0, devices: 0, contributions: 0 }, notifications: { operations: 0, devices: 0 } };
      observations.push(record);
      context.onDispose(() => { record.disposed = true; });
      function release(kind, stop) {
        ++record.subscriptions[kind]; let released = false;
        return () => {
          if (released) return;
          released = true;
          const result = stop(); --record.subscriptions[kind];
          return result;
        };
      }
      function adapt(base) {
        const { devices, extensions, ...rest } = base;
        const result = { ...rest,
          subscribeOperations(listener) {
            return release('operations', base.subscribeOperations((value) => {
              ++record.notifications.operations; listener(value);
            }));
          },
        };
        if (!omitDevices && devices) result.devices = { ...devices,
          subscribe(listener) {
            return release('devices', devices.subscribe((value) => {
              ++record.notifications.devices; listener(value);
            }));
          },
        };
        if (extensions) result.extensions = { ...extensions,
          ...(extensions.register ? { register(contributions) {
            // 回调也省略同一可选扩展，防止只删 activate 字段而误测有设备的真实回调。
            const mapped = { ...contributions,
              ...(contributions.commands ? { commands: contributions.commands.map((item) => ({ ...item,
                execute: (input, current, caller) => item.execute(input, adapt(current), caller) })) } : {}),
              ...(contributions.services ? { services: contributions.services.map((item) => ({ ...item,
                invoke: (input, current, caller) => item.invoke(input, adapt(current), caller) })) } : {}),
              ...(contributions.beforeTaskSubmit ? { beforeTaskSubmit: contributions.beforeTaskSubmit.map((item) => ({ ...item,
                transform: (input, current, caller) => item.transform(input, adapt(current), caller) })) } : {}),
            };
            return release('contributions', extensions.register(mapped));
          } } : {}),
        };
        return Object.freeze(result);
      }
      record.context = adapt(context);
      await plugin.activate?.(record.context);
    } } };
  };
}

export function observationBrief(record) {
  return { url: record.url, omitDevices: record.omitDevices, aborted: record.signal.aborted,
    disposed: record.disposed, subscriptions: { ...record.subscriptions }, notifications: { ...record.notifications } };
}
