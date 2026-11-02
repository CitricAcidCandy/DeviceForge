import { createLegacyRuntimeAdapter } from '../composition/legacy-runtime.ts';
import { createLegacyProductBusiness } from './legacy-business.ts';
import type { ProductPlatformServices } from './platform-services.ts';
import type { ProfileReference } from '../../features/android-profile/index.ts';

/** 旧界面显式取得兼容业务；释放适配器不关闭借用的平台运行时。 */
export function createLegacyProductAdapter(core: ProductPlatformServices, options: { readonly registerServices?: boolean } = {}) {
  core.runtime.host.signal.throwIfAborted();
  const runtimeAdapter = createLegacyRuntimeAdapter(core.runtime, options);
  const legacy = createLegacyProductBusiness(core.runtime);
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const tasks = [legacy.dispose, runtimeAdapter.dispose].map((release) => {
      try { return Promise.resolve(release()); } catch (error) { return Promise.reject(error); }
    });
    closing = Promise.allSettled(tasks).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '旧产品适配释放未确认');
    });
    return closing;
  };
  const releaseOwner = core.runtime.host.onDispose(close);
  return {
    services: {
      ...core, runtime: runtimeAdapter.runtime,
      get marketplace() { return legacy.marketplace; },
      get webRtcMirroring() { return legacy.webRtcMirroring; },
      get packageAnalysis() { return legacy.packageAnalysis; },
      get frida() { return legacy.frida; },
      get automation() { return legacy.automation; },
      get settings() { return legacy.settings; },
      get aiAssistant() { return legacy.aiAssistant; },
      get dex() { return legacy.dex; },
      get msgpack() { return legacy.msgpack; },
      get toolSupply() { return legacy.toolSupply; },
      get sessions() { return legacy.sessions; },
      get artifactBrowser() { return legacy.artifactBrowser; },
      get mirroring() { return legacy.mirroring; },
      get aiStreaming() { return legacy.aiStreaming; },
      profile: (reference: ProfileReference) => legacy.profile(reference),
    },
    dispose(): Promise<void> {
      const pending = close();
      void Promise.resolve(releaseOwner()).catch(() => undefined);
      return pending;
    },
  };
}
