import { useState } from 'react';
import { PageTitle } from '../../components/index.ts';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/Tabs/index.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { DeviceAutomation } from './components/DeviceAutomation/index.tsx';
import { DesktopAutomation } from './components/DesktopAutomation/index.tsx';
import { InputTraceAutomation } from './components/InputTraceAutomation/index.tsx';

export function AutomationPage({ services }: { services: ProductServices }) {
  const [workspace, setWorkspace] = useState('device');
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col text-sm">
      <PageTitle title="自动化" />
      <Tabs className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col gap-0" value={workspace} onValueChange={setWorkspace}>
        {/* 标签栏不滚动：三个短标签用换行容纳，避免出现横向滚动条压掉下划线。 */}
        <TabsList className="max-w-full flex-wrap" aria-label="自动化工作区">
          <TabsTrigger value="device">设备步骤</TabsTrigger>
          <TabsTrigger value="desktop">桌面操作</TabsTrigger>
          <TabsTrigger value="trace">输入录制与回放</TabsTrigger>
        </TabsList>
        <TabsContent className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden" value="device" forceMount hidden={workspace !== 'device'}>
          <DeviceAutomation services={services} />
        </TabsContent>
        <TabsContent className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden" value="desktop" forceMount hidden={workspace !== 'desktop'}>
          <DesktopAutomation services={services} />
        </TabsContent>
        <TabsContent className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden" value="trace" forceMount hidden={workspace !== 'trace'}>
          <InputTraceAutomation services={services} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
