import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import * as components from '../components/index.ts';
import { cn } from '../utils/classnames.ts';
import type { Dispose, HostUi } from '../plugin-sdk/index.ts';

// 插件包与宿主分开构建，无法从宿主的打包图里解析 react。
// 宿主把实例与组件桶摊平挂到一个全局契约上，插件经 /plugin-host.js 垫片取用，
// 于是 React 只有一份，组件样式、主题变量、无障碍标注也自动跟随宿主。
// 契约本身定义在 plugin-sdk/ui.ts，插件侧只需认那一份。
function mountReact(root: HTMLElement, element: React.ReactElement): Dispose {
  const instance = ReactDOMClient.createRoot(root);
  flushSync(() => {
    instance.render(element);
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 卸载若发生在别的 React 树提交期间，React 会报同步更新冲突，统一走 flushSync。
    flushSync(() => {
      instance.unmount();
    });
  };
}

const hostUi = {
  apiVersion: 1,
  React,
  ReactDOMClient,
  jsx,
  jsxs,
  Fragment,
  cn,
  mountReact,
  ...components,
};

export interface HostUiHolder {
  __DEVICEFORGE_HOST_UI__?: HostUi | undefined;
}

/**
 * 把界面套件挂到全局，返回的释放函数还原上一次挂载（测试与热更新都靠它收尾）。
 */
export function installPublicUi(target: HostUiHolder = globalThis): Dispose {
  const previous = target.__DEVICEFORGE_HOST_UI__;
  // 宿主这边组件带精确属性类型，公开契约刻意放宽到「按名字可用」，
  // 两者是一份实现与一份面向插件的声明，这里按声明发布。
  target.__DEVICEFORGE_HOST_UI__ = hostUi as unknown as HostUi;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (target.__DEVICEFORGE_HOST_UI__ === (hostUi as unknown as HostUi))
      target.__DEVICEFORGE_HOST_UI__ = previous;
  };
}
