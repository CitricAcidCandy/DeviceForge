// 自动生成自 src/app/public-ui-react.ts；禁止手工修改，请运行 node scripts/generate-public-ui.ts。
// 浏览器垫片只读取宿主实例，不引入第二份 React。
const ui = globalThis.__DEVICEFORGE_HOST_UI__;
if (!ui)
    throw new Error('宿主未提供界面套件：请在 DeviceForge 完成启动后加载插件');
export const { Activity, Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, ViewTransition, act, addTransitionType, cache, cacheSignal, captureOwnerStack, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useEffectEvent, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version, } = ui.React;
export default ui.React;
