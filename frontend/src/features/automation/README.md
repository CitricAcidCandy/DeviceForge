# 自动化业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

`createHttpAutomation` 通过生成类型和真实 HTTP 任务网关消费七项公开贡献：`plugin.automation.sequence.run`、`click.repeat`、`windows.mouse.position`、`windows.mouse.click`、`windows.mouse.repeat`、`input_trace.record` 和 `input_trace.playback`，后六项均使用相同 `plugin.automation.` 前缀。新提交前先显式 `refreshOperations`；目录只接纳这七个完整 ID。刷新开始即清旧入口，失败、取消、替换和销毁后的晚结果不能恢复贡献；`snapshot` 保留本次观察与真实日志 ID。

`createAutomation(gateway, options, artifacts?)` 保留原注入签名及全部旧方法，`options.operations` 可选接入动态目录。未注入目录时保持旧执行语义，空目录不代表发现了贡献。`catalog.ts` 负责目录代际；`rules.ts` 校验设备、动作范围、最多 10000 步和一小时内非递减时间；`results.ts` 校验设备和完整派发数量；`index.ts` 组合执行、`queryJob`、恢复等待和显式取消。请求字段保持平铺，输入与业务结果均建立冻结副本；调用者修改步骤或嵌套鼠标参数不改变已提交操作与解码预期。

Android 成功结果固定消费真实产物封套及空产物列表，并保留 `effect_confirmed:false`。`completed` 表示动作工具已完成派发，不证明设备界面已产生预期效果。失败或取消后不得自动重放已执行动作；恢复只查询原任务，不提交新序列。Android 请求不包含自由命令或服务器程序路径。

`desktop-types.ts`、`desktop-rules.ts`、`desktop-results.ts` 与 `desktop.ts` 分别承载 Windows 鼠标和输入轨迹的类型、纯校验、结果消费及编排，仍复用共享任务执行器。鼠标位置采用虚拟桌面坐标，点击区分左右中键和单双击；结果位置是实际指针观测，省略请求位置时也返回当前坐标。重复点击支持次数、时长和有界手动模式，保留 F9、次数上限、时长或 `manual_limit` 停止原因及实际耗时。后端部署须显式启用桌面控制，不把 Android 设备输入复用为 Windows 全局输入。

输入轨迹通过 `input_trace.record/playback` 提交真实贡献，事件类型为 0 全部、1 键盘、2 鼠标，采样间隔为 2–1000 毫秒，录制时长为 100–600000 毫秒。只有 `stdin_exit` 正常停止的录制才消费成功；强制结束不作完成。录制固定三项产物 `recording.msgpack`、`operation.json` 与 `input-trace.log`，回放固定后两项；消费事件数为 1–100000，单产物大小最多 64 MiB。回放仅传公开产物 ID，按有效 Unicode、最多 200 个 UTF-8 字节和无控制字符校验。

轨迹为连续 MessagePack 记录，`downloadTrace` 重新核对固定产物集合后按原字节大小与 SHA-256 验证，保留真实下载日志；不解析为 JSON，也不据此证明私有格式兼容。既有泛型下载门面仍可使用已经发布的轨迹产物封套。`createAutomation` 第三个可选参数注入公开下载能力，没有该能力时明确失败；HTTP 工厂直接映射生成的产物接口。取消和销毁及时结束客户端目录、任务及下载等待，消费忽略信号的晚到拒绝；已收到下载响应后取消仍保留日志。

目录失效不阻止查询、恢复和显式取消历史任务。取消客户端等待不自动取消服务器，不重放已派发动作；`dispose` 也不声明服务器桌面操作、输入轨迹工具或远端资源已经退出。设备序列输入允许一小时内的调度，但实际执行仍受公开贡献总期限约束，长序列不能据输入合法宣称必定执行完成。

原三个自动化测试文件保持字节不变，新增 `automation-http-consumption.test.ts` 覆盖七目录和实际输入、全部恢复入口、目录竞态、嵌套冻结、结果及产物边界、原字节下载与销毁。当前提供框架无关业务用例和协议测试；真实设备效果、服务器桌面、F9 按键、原生 InputTrace 格式兼容、录制/编辑产品页面、视觉与长时间调度验收仍需单独完成。

`convertLegacyMouse` 纯转换旧 AutoMouse 配置到现有 `DesktopRepeat`，不提交任务、不修改输入。保留旧字段 `mouseButtonType`（0左/1中/2右）、`clickType`（0单/1双）、`clickCountType`（0为100毫秒/1为10毫秒/2用timeInterval）和 `repeatedType`（0手动/1次数/2时长）。时长单位为秒，精确乘1000得到整数毫秒，不复刻旧实现减一秒；不能精确得到整数毫秒时拒绝，不取整。手动必须提供 `manualMaxDurationMs`，沿用100–600000毫秒限额并启用F9停止；此上限是明确新增的有界策略，不等于复刻无限运行。

自定义位置接受原IPC的 `clickPos:{x,y}` 或表单的 `clickPosX/clickPosY`，二者混用或缺半对时拒绝；当前位置模式不输出坐标。所有坐标为有符号32位整数，不填默认零、不钳制、不强转字符串。当前间隔10–60000毫秒、次数1–10000及总调度600000毫秒限制继续由原校验执行；未知字段和非法枚举拒绝。调用方取得转换结果后显式调用 `repeatMouse` 并传入取消信号；转换测试及假网关不证明服务器桌面/F9实际运行、旧通知或热键启动已迁移。

`clickPosType` 为0当前位置、1自定义位置。次数模式读取 `repeatedClickCount`，时长模式读取 `repeatedClickDuration`（秒）；非活动间隔/次数/时长允许旧零占位，活动自定义间隔、次数或时长为零仍拒绝。固定速度档位不使用 `timeInterval:0`，不把占位值传入新请求。
