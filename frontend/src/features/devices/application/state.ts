import { HostError } from '../../../plugin-sdk/index.ts';
import type { DeviceAction, DeviceDirectory, DeviceProviderInfo, DeviceRef, DeviceSnapshot } from '../../../plugin-sdk/index.ts';
import { findDevice, requireDevice, requireProvider, sameReference } from '../domain/rules.ts';

export function createDeviceState(onChange: (next: DeviceSnapshot, previous: DeviceSnapshot) => void) {
  let providers: readonly DeviceProviderInfo[] = [];
  let directories: readonly DeviceDirectory[] = [];
  let selection: DeviceRef | null = null;
  let providersKnown = false;
  let closed = false;
  let providerRevision = 0;
  let observationRevision = 0;
  const revisions = new Map<string, number>();
  const listeners = new Set<(value: DeviceSnapshot) => void>();
  const check = () => { if (closed) throw new HostError('cancelled', 'devices_closed', '设备目录已关闭'); };
  const snapshot = (): DeviceSnapshot => Object.freeze({ providers, directories, selection, selected: selection ? findDevice(directories, selection) : null });
  function publish(previous: DeviceSnapshot) {
    if (selection && (!providers.some((item) => item.id === selection?.providerId && item.generation === selection.generation) || !findDevice(directories, selection))) selection = null;
    const next = snapshot(); onChange(next, previous);
    for (const listener of listeners) { try { listener(next); } catch { /* 一个订阅失败不影响其他订阅或网络结果。 */ } }
  }
  function replaceDirectories(next: readonly DeviceDirectory[]) {
    const previous = snapshot(); directories = Object.freeze([...next]); ++observationRevision;
    for (const item of [...previous.directories, ...next]) revisions.set(item.provider.id, (revisions.get(item.provider.id) ?? 0) + 1);
    publish(previous);
  }
  return {
    snapshot: () => { check(); return snapshot(); },
    known: () => providersKnown,
    providerRevision: () => providerRevision,
    observationRevision: () => observationRevision,
    directoryRevision: (id: string) => revisions.get(id) ?? 0,
    updateProviders(next: readonly DeviceProviderInfo[]) {
      check(); const previous = snapshot(); providersKnown = true;
      if (providers.length !== next.length || providers.some((item) => !next.some((value) => item.id === value.id && item.generation === value.generation))) ++providerRevision;
      providers = Object.freeze([...next]);
      const retained = directories.filter((item) => providers.some((provider) => provider.id === item.provider.id && provider.generation === item.provider.generation));
      if (retained.length !== directories.length) { directories = Object.freeze(retained); ++observationRevision; }
      publish(previous);
    },
    updateDirectories(next: readonly DeviceDirectory[]) { check(); replaceDirectories(next); },
    updateDirectory(next: DeviceDirectory) {
      check(); requireProvider(providers, next.provider.id, next.provider.generation);
      const previous = snapshot(); directories = Object.freeze([...directories.filter((item) => item.provider.id !== next.provider.id), next]);
      revisions.set(next.provider.id, (revisions.get(next.provider.id) ?? 0) + 1); ++observationRevision; publish(previous);
    },
    clearDirectory(id: string, generation: string) {
      check();
      if (!directories.some((item) => item.provider.id === id && item.provider.generation === generation)) return;
      const previous = snapshot();
      directories = Object.freeze(directories.filter((item) => item.provider.id !== id || item.provider.generation !== generation));
      revisions.set(id, (revisions.get(id) ?? 0) + 1); ++observationRevision; publish(previous);
    },
    invalidateProvider(id: string) {
      check(); const previous = snapshot();
      providers = Object.freeze(providers.filter((item) => item.id !== id));
      directories = Object.freeze(directories.filter((item) => item.provider.id !== id));
      ++providerRevision; ++observationRevision; revisions.set(id, (revisions.get(id) ?? 0) + 1); publish(previous);
    },
    select(reference: DeviceRef | null) {
      check();
      if (reference) { requireProvider(providers, reference.providerId, reference.generation); requireDevice(directories, reference); }
      if (sameReference(reference, selection)) return;
      const previous = snapshot(); selection = reference ? Object.freeze({ ...reference }) : null; publish(previous);
    },
    subscribe(listener: (value: DeviceSnapshot) => void) { check(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { closed = true; listeners.clear(); providers = []; directories = []; selection = null; },
  };
}

export function actionTargets(action: DeviceAction, reference: DeviceRef | null): boolean {
  return !!reference && action.providerId === reference.providerId && action.generation === reference.generation && action.deviceId === reference.localId;
}
