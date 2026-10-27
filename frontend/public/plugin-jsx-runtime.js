// 自动生成自 src/app/public-ui-jsx-runtime.ts；禁止手工修改，请运行 node scripts/generate-public-ui.ts。
const ui = globalThis.__DEVICEFORGE_HOST_UI__;
if (!ui)
    throw new Error('宿主未提供界面套件：请在 DeviceForge 完成启动后加载插件');
export const { jsx, jsxs, Fragment } = ui.jsxRuntime;
export default ui.jsxRuntime;
