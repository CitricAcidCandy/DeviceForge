import { createApiClient } from '../../services/api/index.ts';
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
import type { JobGateway } from '../../shared/jobs/index.ts';
import type { RuntimeOptions } from '../runtime.ts';
import { createFrontendRuntime } from '../runtime.ts';
import { createMediaDisplay } from './media-display.ts';
import { createHttpWebRtcMirroring } from '../../features/mirroring-streaming/index.ts';
import { createPluginDefaults } from '../../features/plugin-defaults/index.ts';
import { createMessageController } from '../../components/Message/index.ts';
import { createMarketplace } from '../../features/marketplace/index.ts';

export interface ProductConnection {
  readonly baseUrl: string;
  reconnect(baseUrl: string, token: string, signal: AbortSignal): Promise<void>;
}

// 产品装配复用原工厂与任务钩子，不在页面中创建第二套业务协议。
export function createProductServices(
  options: RuntimeOptions & { readonly connection?: ProductConnection },
) {
  const messages = createMessageController();
  const marketplace = createMarketplace();
  const mediaDisplay = createMediaDisplay();
  const runtime = createFrontendRuntime({
    ...options,
    mirroringSink: options.mirroringSink ?? mediaDisplay.sink,
  });
  const pluginDefaults = createPluginDefaults({
    packages: runtime.pluginPackages,
    serverPlugins: runtime.serverPlugins,
    browserPlugins: runtime.webPlugins,
    signal: runtime.host.signal,
  });
  const client = createApiClient(options);
  const webRtcMirroring = createHttpWebRtcMirroring(client);
  const gateway: JobGateway = {
    submit: (operation, input, signal) => runtime.tasks.submit({ operation, input }, signal),
    getJob: runtime.tasks.get,
    cancelJob: runtime.tasks.cancel,
  };
  const operations = { list: runtime.operations.list };
  const artifacts = runtime.artifacts;
  const packageAnalysis = createPackageAnalysis(gateway, {}, artifacts);
  const publicArtifacts = runtime.host.artifacts;
  if (!publicArtifacts) throw new Error('产品装配缺少公开产物服务');
  const frida = createFrida(gateway, publicArtifacts, { operations });
  const automation = createAutomation(gateway, { operations }, artifacts);
  const settings = createSettings(gateway);
  const aiAssistant = createAiAssistant(gateway);
  const dex = createDexAnalysis(gateway, operations);
  const msgpack = createMsgpack(gateway, {}, artifacts);
  const toolSupply = createToolSupply(gateway);
  const sessions = createHttpInteractiveSessions(client);
  const artifactBrowser = createHttpArtifactBrowser(client);
  const mirroring = createMirroring(gateway, artifacts, { operations });
  const aiStreaming = createHttpAiStreaming(client);
  let closing: Promise<void> | null = null;
  return {
    runtime,
    pluginDefaults,
    messages,
    marketplace,
    client,
    mediaDisplay,
    webRtcMirroring,
    connection: options.connection ?? null,
    packageAnalysis,
    frida,
    automation,
    settings,
    aiAssistant,
    dex,
    msgpack,
    toolSupply,
    sessions,
    artifactBrowser,
    mirroring,
    aiStreaming,
    profile: (reference: ProfileReference) => createAndroidProfile(runtime.host, reference),
    dispose(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        pluginDefaults.dispose();
        messages.dispose();
        packageAnalysis.dispose();
        frida.dispose();
        automation.dispose();
        settings.dispose();
        aiAssistant.dispose();
        dex.dispose();
        msgpack.dispose();
        toolSupply.dispose();
        sessions.dispose();
        artifactBrowser.dispose();
        mirroring.dispose();
        aiStreaming.dispose();
        const results = await Promise.allSettled([
          webRtcMirroring.dispose(), runtime.dispose(), mediaDisplay.dispose(),
        ]);
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, '产品运行实例清理失败');
      })();
      return closing;
    },
  };
}
export type ProductServices = ReturnType<typeof createProductServices>;
