const ui = globalThis.__DEVICEFORGE_HOST_UI__;
if (!ui) throw new Error('宿主未提供界面套件：请在 DeviceForge 完成启动后加载插件');
export const {
  browser, createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule,
  preload, preloadModule, requestFormReset, unstable_batchedUpdates, useFormState,
  useFormStatus, version,
} = ui.ReactDOM;
export default ui.ReactDOM;
