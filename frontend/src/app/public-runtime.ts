// 生产静态包的公开宿主入口；页面通过适配器装配，不依赖开发源码路径。
export { createFrontendRuntime } from './runtime.ts';
export type { RuntimeOptions } from './runtime.ts';
export { createNamedSlotAdapter } from '../plugins/index.ts';
