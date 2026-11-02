import { hostUi } from '@deviceforge/plugin-sdk';
import { useEffect, useState } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createAutomationServices } from './services.ts';
const { PageTitle } = hostUi();
const { Tabs, TabsList, TabsTrigger, TabsContent } = hostUi();
import type { AutomationServices } from './services.ts';
import { DeviceAutomation } from './components/DeviceAutomation/index.tsx';
import { DesktopAutomation } from './components/DesktopAutomation/index.tsx';
import { InputTraceAutomation } from './components/InputTraceAutomation/index.tsx';

export function AutomationPage({ services }: { services: AutomationServices }) {
  useEffect(() => {
    void services.operations.list(services.context.signal).catch(() => undefined);
  }, [services]);
  const [workspace, setWorkspace] = useState('device');
  return (
    <section className="@container/automation flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-sm" data-product-page="automation">
      <PageTitle title="自动化" />
      <Tabs className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col gap-0" value={workspace} onValueChange={setWorkspace}>
        {/* 标签栏不滚动：三个短标签用换行容纳，避免出现横向滚动条压掉下划线。 */}
        <TabsList className="max-w-full shrink-0 flex-wrap" aria-label="自动化工作区">
          <TabsTrigger value="device">设备步骤</TabsTrigger>
          <TabsTrigger value="desktop">桌面操作</TabsTrigger>
          <TabsTrigger value="trace">输入录制与回放</TabsTrigger>
        </TabsList>
        <TabsContent className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain data-[state=inactive]:hidden" value="device" forceMount hidden={workspace !== 'device'}>
          <DeviceAutomation services={services} />
        </TabsContent>
        <TabsContent className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain data-[state=inactive]:hidden" value="desktop" forceMount hidden={workspace !== 'desktop'}>
          <DesktopAutomation services={services} />
        </TabsContent>
        <TabsContent className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain data-[state=inactive]:hidden" value="trace" forceMount hidden={workspace !== 'trace'}>
          <InputTraceAutomation services={services} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function mountAutomation(target: HTMLElement, context: HostContext) {
  const services = createAutomationServices(context);
  try {
    const release = hostUi().mountReact(target, <AutomationPage services={services} />);
    return async () => { try { await release(); } finally { services.dispose(); } };
  } catch (error) { services.dispose(); throw error; }
}
