# 宿主残余Harmony设备工具

`HarmonyDeviceTools { hdc }`只声明`harmony.devices`和`harmony.packages`，没有ADB字段。两贡献沿原HDC输入schema、发现过滤、packages诊断与输出，分别保留10秒与30秒旧工具阶段。发现执行`list targets`；包列表执行`-t <device_id> shell bm dump -a`。未知或Android入口直接NotFound，不启动HDC。

旧`DeviceTools`和`parse_adb`保留兼容实现，HDC两个路径与专用执行器共用规则。保留代码不意味着它们继续生产装配；server/main切换、旧绑定归属及实际HTTP/MCP验收由主代理完成。Android首批七能力与发现由独立android-device提供者接入，不为残余工具新增API3声明。

专用执行器仍沿Executor默认context兼容法，不声称旧HDC工作已经获得全阶段原D传播或新的清理观测。Android APK安装、截图、APKS安装和性能仍有各自残余装配，不因这个模块只持HDC就宣称整个宿主已无ADB。

所属harmony/tests.rs覆盖两贡献、两入口拒Android且零工具、原HDC固定argv/数组/output及诊断失败，使用真实独立假工具而非真机。本角色未运行这些测试、格式化或构建；实际结果由主代理串行记录。
