/**
 * 取宿主界面套件。插件必须在宿主里运行；拿不到说明页面不是被宿主加载的，
 * 或者宿主太旧（apiVersion 1 之前的宿主没有这套东西）。
 */
export function hostUi() {
    const ui = globalThis.__DEVICEFORGE_HOST_UI__;
    if (!ui)
        throw new Error('宿主未提供界面套件：请确认插件由 DeviceForge 宿主加载，且宿主支持 hostUi apiVersion 1');
    return ui;
}
