import { installProviders } from './installation.mjs';
import { verifyArtifacts, verifyBadValues } from './artifacts.mjs';
import { verifyLifecycle } from './lifecycle.mjs';

// 导入不启动服务；独立入口和 npx 分发验收都可传入已就绪的公开 HTTP/MCP 宿主。
export async function verifyNestedDeviceArtifacts({ host, fixtures, report }) {
  const context = { host, fixtures, report, history: new Map() };
  for (const [stage, verify] of [
    ['在线安装与发现', installProviders], ['嵌套输入与产物发布', verifyArtifacts],
    ['坏终值与拒绝边界', verifyBadValues], ['取消与热卸载重载', verifyLifecycle],
  ]) {
    report.stage = stage;
    await verify(context);
    host.assertRunning();
  }
  return { history_jobs: [...context.history.keys()], baseline: context.baseline };
}
