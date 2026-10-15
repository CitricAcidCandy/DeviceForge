import { useState } from 'react';
import { PageTitle } from '../../components/index.ts';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/Tabs/index.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { DeviceAutomation } from './components/DeviceAutomation/index.tsx';
import { DesktopAutomation } from './components/DesktopAutomation/index.tsx';
import { InputTraceAutomation } from './components/InputTraceAutomation/index.tsx';
import './workspace.css';

export function AutomationPage({ services }: { services: ProductServices }) {
  const [workspace, setWorkspace] = useState('device');
  return (
    <section className="product-page automation-page">
      <PageTitle
        eyebrow="深度调试"
        title="自动化"
        description="以可读步骤编排设备输入；桌面操作明确作用于运行服务器的电脑。"
      />
      <Tabs value={workspace} onValueChange={setWorkspace}>
        <TabsList aria-label="自动化工作区">
          <TabsTrigger value="device">设备步骤</TabsTrigger>
          <TabsTrigger value="desktop">桌面操作</TabsTrigger>
          <TabsTrigger value="trace">输入录制与回放</TabsTrigger>
        </TabsList>
        <TabsContent value="device" forceMount hidden={workspace !== 'device'}>
          <DeviceAutomation services={services} />
        </TabsContent>
        <TabsContent value="desktop" forceMount hidden={workspace !== 'desktop'}>
          <DesktopAutomation services={services} />
        </TabsContent>
        <TabsContent value="trace" forceMount hidden={workspace !== 'trace'}>
          <InputTraceAutomation services={services} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
