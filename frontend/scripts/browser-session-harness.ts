import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import { createSessionFixture } from './session-test-fixtures.ts';
import { pause } from './session-browser-actions.ts';
import { verifyTerminalAndMcp } from './browser-session-terminal.ts';
import { verifyAiProviders } from './browser-session-ai.ts';
import { verifyFridaAndAutomation } from './browser-session-debug.ts';

export async function verifySessionPages() {
  const fixture = await createSessionFixture();
  const checks: { name: string; passed: true }[] = [];
  const target = document.createElement('main');
  document.body.append(target);
  let root = createRoot(target);
  const services = createProductServices({
    baseUrl: location.origin,
    transport: fixture.transport,
    panelTarget: () => target,
  });
  let stage = '初始化公开目录';
  const failures: { stage: string; error: string; dom: string | undefined }[] = [];
  const context = {
    target,
    services,
    fixture,
    passed: (name: string) => checks.push({ name, passed: true }),
    mount: async (page: ComponentType<{ services: ProductServices }>) => {
      root.unmount();
      target.replaceChildren();
      root = createRoot(target);
      root.render(createElement(StrictMode, null, createElement(page, { services })));
      await pause();
    },
  };
  try {
    const signal = AbortSignal.timeout(60000);
    await services.runtime.operations.refresh(signal);
    await services.runtime.devices.refreshDirectories(signal);
    services.runtime.devices.select({
      providerId: fixture.provider.id,
      generation: fixture.provider.generation,
      localId: 'device-a',
    });
    for (const [name, verify] of [
      ['终端和MCP可见交互', verifyTerminalAndMcp],
      ['CLI与SDK独立会话', verifyAiProviders],
      ['Frida和自动化可见交互', verifyFridaAndAutomation],
    ] as const) {
      stage = name;
      try {
        await verify(context);
      } catch (error) {
        failures.push({
          stage,
          error: error instanceof Error ? error.message : '未知会话验收失败',
          dom: target.textContent?.slice(0, 3000),
        });
      }
    }
    return {
      passed: failures.length === 0,
      checks,
      failures,
      requests: fixture.requests,
      scope: '真实React组件和ProductServices；受控API；无真实设备或桌面输入副作用',
    };
  } catch (error) {
    return {
      passed: false,
      checks,
      failure_stage: stage,
      error: error instanceof Error ? error.message : '未知会话验收失败',
      dom: target.textContent?.slice(0, 3000),
      requests: fixture.requests,
    };
  } finally {
    root.unmount();
    await services.dispose();
    fixture.dispose();
    target.remove();
  }
}
