import { createPackageAnalysis } from '../../features/package-analysis/index.ts';
import { createFrida } from '../../features/frida/index.ts';
import { createAutomation } from '../../features/automation/index.ts';
import { createSettings } from '../../features/settings/index.ts';
import { createAiAssistant } from '../../features/ai-assistant/index.ts';
import { createDexAnalysis } from '../../features/dex-analysis/index.ts';
import { createMsgpack } from '../../features/msgpack/index.ts';
import { createToolSupply } from '../../features/tool-supply/index.ts';
import { createHttpInteractiveSessions } from '../../features/interactive-sessions/index.ts';
import { createHttpArtifactBrowser } from '../../features/artifact-browser/index.ts';
import { createMirroring } from '../../features/mirroring/index.ts';
import { createHttpAiStreaming } from '../../features/ai-streaming/index.ts';
import { createAndroidProfile } from '../../features/android-profile/index.ts';
import type { ProfileReference } from '../../features/android-profile/index.ts';
import { createHttpWebRtcMirroring } from '../../features/mirroring-streaming/index.ts';
import { createMarketplace } from '../../features/marketplace/index.ts';
import type { JobGateway } from '../../shared/jobs/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { createLazyProductResources } from './lazy-resources.ts';

/** 明确的迁移兼容层；官方独立插件不得引用本工厂或其结果。 */
export function createLegacyProductBusiness(runtime: PlatformRuntime) {
  const resources = createLazyProductResources();
  const client = runtime.requestClient, artifacts = runtime.artifacts;
  const operations = { list: runtime.operations.list };
  const gateway: JobGateway = {
    submit: (operation, input, signal) => runtime.tasks.submit({ operation, input }, signal),
    getJob: runtime.tasks.get, cancelJob: runtime.tasks.cancel,
  };
  const publicArtifacts = runtime.host.artifacts;
  if (!publicArtifacts) throw new Error('旧业务兼容装配缺少公开产物服务');
  // 市场适配器只保存地址；请求均使用调用方信号，没有自有长期资源。
  const marketplace = resources.lazy('marketplace', createMarketplace, () => {});
  const webRtcMirroring = resources.lazy('webRtcMirroring', () => createHttpWebRtcMirroring(client), (value) => value.dispose());
  const packageAnalysis = resources.lazy('packageAnalysis', () => createPackageAnalysis(gateway, {}, artifacts), (value) => value.dispose());
  const frida = resources.lazy('frida', () => createFrida(gateway, publicArtifacts, { operations }), (value) => value.dispose());
  const automation = resources.lazy('automation', () => createAutomation(gateway, { operations }, artifacts), (value) => value.dispose());
  const settings = resources.lazy('settings', () => createSettings(gateway), (value) => value.dispose());
  const aiAssistant = resources.lazy('aiAssistant', () => createAiAssistant(gateway), (value) => value.dispose());
  const dex = resources.lazy('dex', () => createDexAnalysis(gateway, operations), (value) => value.dispose());
  const msgpack = resources.lazy('msgpack', () => createMsgpack(gateway, {}, artifacts), (value) => value.dispose());
  const toolSupply = resources.lazy('toolSupply', () => createToolSupply(gateway), (value) => value.dispose());
  const sessions = resources.lazy('sessions', () => createHttpInteractiveSessions(client), (value) => {
    const release = value.releaseSelectedTerminal();
    value.dispose();
    return release.then(() => undefined);
  });
  const artifactBrowser = resources.lazy('artifactBrowser', () => createHttpArtifactBrowser(client), (value) => value.dispose());
  const mirroring = resources.lazy('mirroring', () => createMirroring(gateway, artifacts, { operations }), (value) => value.dispose());
  const aiStreaming = resources.lazy('aiStreaming', () => createHttpAiStreaming(client), (value) => value.dispose());
  return {
    get marketplace() { return marketplace(); },
    get webRtcMirroring() { return webRtcMirroring(); },
    get packageAnalysis() { return packageAnalysis(); },
    get frida() { return frida(); },
    get automation() { return automation(); },
    get settings() { return settings(); },
    get aiAssistant() { return aiAssistant(); },
    get dex() { return dex(); },
    get msgpack() { return msgpack(); },
    get toolSupply() { return toolSupply(); },
    get sessions() { return sessions(); },
    get artifactBrowser() { return artifactBrowser(); },
    get mirroring() { return mirroring(); },
    get aiStreaming() { return aiStreaming(); },
    profile: (reference: ProfileReference) => createAndroidProfile(runtime.host, reference),
    snapshot: resources.snapshot,
    dispose: resources.dispose,
  };
}
