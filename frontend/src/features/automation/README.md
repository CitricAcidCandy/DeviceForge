# 自动化业务用例

`createAutomation` 提交 `plugin.automation.sequence.run` 和 `plugin.automation.click.repeat`，只接受结构化点击、滑动、按键及有界 ASCII 文本。`rules.ts` 校验设备、动作范围、最多 10000 步和一小时内非递减时间；`results.ts` 校验设备和完整派发数量；`index.ts` 负责执行、恢复等待和显式取消。

Android 成功结果固定消费真实产物封套及空产物列表，并保留 `effect_confirmed:false`。`completed` 表示动作工具已完成派发，不证明设备界面已产生预期效果。失败或取消后不得自动重放已执行动作；恢复只查询原任务，不提交新序列。Android 请求不包含自由命令或服务器程序路径。

`desktop-types.ts`、`desktop-rules.ts`、`desktop-results.ts` 与 `desktop.ts` 分别承载 Windows 鼠标和输入轨迹的类型、纯校验、结果消费及编排，仍复用共享任务执行器。鼠标位置采用虚拟桌面坐标，点击区分左右中键和单双击；结果位置是实际指针观测，省略请求位置时也返回当前坐标。重复点击支持次数、时长和有界手动模式，保留 F9、次数上限、时长或 `manual_limit` 停止原因及实际耗时。后端部署须显式启用桌面控制，不把 Android 设备输入复用为 Windows 全局输入。

输入轨迹通过 `input_trace.record/playback` 提交真实贡献，事件类型为 0 全部、1 键盘、2 鼠标，采样间隔最低 2 毫秒。只有 `stdin_exit` 正常停止的录制才消费成功；强制结束不作完成。轨迹是连续 MessagePack 记录，前端按原字节下载与摘要核对，不误解析成 JSON；回放仅传产物 ID。`createAutomation` 第三个可选参数注入公开产物下载能力，没有该能力时下载明确失败。

当前提供框架无关业务用例及目标协议测试；真实设备效果、录制/编辑产品页面、视觉与长时间调度验收仍需单独完成。

`convertLegacyMouse` 纯转换旧 AutoMouse 配置到现有 `DesktopRepeat`，不提交任务、不修改输入。保留旧字段 `mouseButtonType`（0左/1中/2右）、`clickType`（0单/1双）、`clickCountType`（0为100毫秒/1为10毫秒/2用timeInterval）和 `repeatedType`（0手动/1次数/2时长）。时长单位为秒，精确乘1000得到整数毫秒，不复刻旧实现减一秒；不能精确得到整数毫秒时拒绝，不取整。手动必须提供 `manualMaxDurationMs`，沿用100–600000毫秒限额并启用F9停止；此上限是明确新增的有界策略，不等于复刻无限运行。

自定义位置接受原IPC的 `clickPos:{x,y}` 或表单的 `clickPosX/clickPosY`，二者混用或缺半对时拒绝；当前位置模式不输出坐标。所有坐标为有符号32位整数，不填默认零、不钳制、不强转字符串。当前间隔10–60000毫秒、次数1–10000及总调度600000毫秒限制继续由原校验执行；未知字段和非法枚举拒绝。调用方取得转换结果后显式调用 `repeatMouse` 并传入取消信号；转换测试及假网关不证明服务器桌面/F9实际运行、旧通知或热键启动已迁移。

`clickPosType` 为0当前位置、1自定义位置。次数模式读取 `repeatedClickCount`，时长模式读取 `repeatedClickDuration`（秒）；非活动间隔/次数/时长允许旧零占位，活动自定义间隔、次数或时长为零仍拒绝。固定速度档位不使用 `timeInterval:0`，不把占位值传入新请求。
