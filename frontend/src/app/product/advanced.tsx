import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { PackagesPage } from './pages/packages.tsx';
import { FilesPage } from './pages/files.tsx';
import { MediaPage } from './pages/media.tsx';
import { PerformancePage } from './pages/performance.tsx';
import { FridaPage } from './pages/frida.tsx';
import { AutomationPage } from './pages/automation.tsx';
import { TerminalPage } from './pages/terminal.tsx';
import { AiPage } from './pages/ai.tsx';
import { AnalysisPage } from './pages/analysis.tsx';
import { ToolsPage } from './pages/tools.tsx';

export function AdvancedPage({route, services}: {route: ProductRoute; services: ProductServices}) {
  switch (route) {
    case 'packages': return <PackagesPage services={services} />;
    case 'files': return <FilesPage services={services} />;
    case 'media': return <MediaPage services={services} />;
    case 'performance': return <PerformancePage services={services} />;
    case 'frida': return <FridaPage services={services} />;
    case 'automation': return <AutomationPage services={services} />;
    case 'terminal': return <TerminalPage services={services} />;
    case 'ai': return <AiPage services={services} />;
    case 'analysis': return <AnalysisPage services={services} />;
    case 'tools': return <ToolsPage services={services} />;
    default: return null;
  }
}
