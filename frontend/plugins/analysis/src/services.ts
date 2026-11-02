import type { HostContext } from '@deviceforge/plugin-sdk';
import { createOperationSource, createPublicGateway } from '@deviceforge/business-kit/platform';
import { createDexAnalysis } from './dex-analysis/index.ts';
import { createMsgpack } from './msgpack/index.ts';

export function createAnalysisServices(context: HostContext) {
  const artifacts = context.artifacts;
  if (!artifacts) throw new Error('分析工作区需要公开产物能力');
  const operations = createOperationSource(context);
  const gateway = createPublicGateway(context);
  const dex = createDexAnalysis(gateway, operations);
  const msgpack = createMsgpack(gateway, {}, artifacts);
  return {
    context, artifacts, operations, dex, msgpack,
    dispose() { operations.dispose(); dex.dispose(); msgpack.dispose(); },
  };
}
export type AnalysisServices = ReturnType<typeof createAnalysisServices>;
