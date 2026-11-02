import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import * as components from '../components/index.ts';
import { PortalBoundary, usePortalContentRef } from '../components/PortalBoundary/index.tsx';
import { cn } from '../utils/classnames.ts';
import type { Dispose, HostUi } from '../plugin-sdk/index.ts';
import { createPortalOwnership } from './portal-ownership.ts';

// 插件包与宿主分开构建，无法从宿主的打包图里解析 react。
// 宿主把实例与组件桶摊平挂到一个全局契约上，插件经 /plugin-host.js 垫片取用，
// 于是 React 只有一份，组件样式、主题变量、无障碍标注也自动跟随宿主。
// 契约本身定义在 plugin-sdk/ui.ts，插件侧只需认那一份。
function mountReact(root: HTMLElement, element: React.ReactElement): Dispose {
  const portals = createPortalOwnership(root);
  let initial = true;
  const initialResult: { failure: { readonly error: unknown } | null } = { failure: null };
  const instance = ReactDOMClient.createRoot(root, {
    onUncaughtError(error) {
      // React 19通过回调报告提交错误，flushSync返回本身不代表首次渲染成功。
      if (initial) { initialResult.failure = { error }; return; }
      const window = root.ownerDocument.defaultView;
      if (window?.reportError) window.reportError(error);
      else console.error('插件React视图发生未捕获错误', error);
    },
  });
  try {
    ReactDOM.flushSync(() => {
      instance.render(React.createElement(PortalBoundary, { report: portals.register, children: element }));
    });
    // 包装对象区分没有错误与插件抛出的null/undefined。
    if (initialResult.failure !== null) throw initialResult.failure.error;
  } catch (error) {
    initial = false;
    portals.dispose();
    try {
      ReactDOM.flushSync(() => { instance.unmount(); });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'React首次渲染失败且根回收不完整', { cause: error });
    }
    throw error;
  }
  initial = false;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 先同步撤销归属，React卸载失败或用户ref晚到均不能重新登记旧弹层。
    portals.dispose();
    // 卸载若发生在别的 React 树提交期间，React 会报同步更新冲突，统一走 flushSync。
    ReactDOM.flushSync(() => {
      instance.unmount();
    });
  };
}

const hostUi = {
  apiVersion: 1,
  React,
  ReactDOMClient,
  ReactDOM,
  jsxRuntime,
  jsxDevRuntime,
  jsxDEV: jsxDevRuntime.jsxDEV,
  jsx,
  jsxs,
  Fragment,
  cn,
  mountReact,
  usePortalContentRef,
  ...components,
} satisfies HostUi;

export interface HostUiHolder {
  __DEVICEFORGE_HOST_UI__?: HostUi | undefined;
}

/**
 * 把界面套件挂到全局，返回的释放函数还原上一次挂载（测试与热更新都靠它收尾）。
 */
export function installPublicUi(target: HostUiHolder = globalThis): Dispose {
  const previous = target.__DEVICEFORGE_HOST_UI__;
  target.__DEVICEFORGE_HOST_UI__ = hostUi;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (target.__DEVICEFORGE_HOST_UI__ === hostUi)
      target.__DEVICEFORGE_HOST_UI__ = previous;
  };
}
