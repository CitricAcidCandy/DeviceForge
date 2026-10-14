import { PageTitle } from '../../../components/index.ts';
import type { ProductServices } from '../services.ts';
import { DeviceAutomation } from './automation-device.tsx';
import { DesktopAutomation } from './automation-desktop.tsx';
import { InputTraceAutomation } from './automation-trace.tsx';

export function AutomationPage({services}: {services: ProductServices}) {
  return <section className="product-page"><PageTitle eyebrow="深度调试" title="自动化" description="以可读步骤编排设备输入；桌面操作明确作用于运行服务器的电脑。" />
    <DeviceAutomation services={services} />
    <DesktopAutomation services={services} />
    <InputTraceAutomation services={services} />
  </section>;
}
