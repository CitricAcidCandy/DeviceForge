import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { FilesPage } from '../../pages/files/index.tsx';
import { PerformancePage } from '../../pages/performance/index.tsx';
import { FridaPage } from '../../pages/frida/index.tsx';
import { AutomationPage } from '../../pages/automation/index.tsx';
import { TerminalPage } from '../../pages/terminal/index.tsx';
import { AiPage } from '../../pages/ai/index.tsx';
import { AnalysisPage } from '../../pages/analysis/index.tsx';
import { ToolsPage } from '../../pages/tools/index.tsx';

// 画面与应用已并入设备工作台，这里只保留需要独立路由的深度调试与工坊页面。
export function AdvancedPage({
  route,
  services,
}: {
  route: ProductRoute;
  services: ProductServices;
  active: boolean;
}) {
  switch (route) {
    case 'files':
      return <FilesPage services={services} />;
    case 'performance':
      return <PerformancePage services={services} />;
    case 'frida':
      return <FridaPage services={services} />;
    case 'automation':
      return <AutomationPage services={services} />;
    case 'terminal':
      return <TerminalPage services={services} />;
    case 'ai':
      return <AiPage services={services} />;
    case 'analysis':
      return <AnalysisPage services={services} />;
    case 'tools':
      return <ToolsPage services={services} />;
    default:
      return null;
  }
}
