# Android Unicode 输入消费

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块通过公开 `HostContext.devices` 的 `DeviceAccess.invoke` 消费提供者声明的 `input` v1 能力。它只读取完整设备引用、在线状态和能力可用性，不按平台名称猜测提供者，不覆盖部署者配置，也不直接访问 ADB、HDC 或服务器路径。

输入为 `{ text, enter? }`。文本必须是非空、合法 Unicode 且不含控制字符；可打印 ASCII 的 UTF-8 字节数上限为 1024，包含非 ASCII 字符时上限为 4096。请求保持 `{ action: { kind: 'text', text, enter? } }`，省略 `enter` 表示 false。前端保留文本和字段原样，不转义、不拆分、不静默回退。

提供者使用 `input` v1 能力决定执行方式：可打印 ASCII 可走既有 shell 输入，Unicode 使用部署者显式配置的 `com.android.adbkeyboard` 与 `ADB_INPUT_TEXT` 广播；前端不传包名、组件名或覆盖配置。ASCII 成功结果为 `{ device_id, action: 'text', dispatched: true }`；Unicode 结果额外包含 `transport: 'adb_keyboard_base64'` 和匹配 UTF-8 字节数。

成功只表示工具接受广播或输入请求，不证明真机已经插入目标应用。失败沿公开 `HostError` 保留 `invalid_input`、依赖失败、取消和超时边界，日志 ID从宿主结果继续传递；错误不回传原始输入、命令或配置。设备切换、提供者换代、取消和销毁由宿主设备门面撤销在途请求并隔离晚到结果。

## 验证边界

`android-input-consumption.test.ts` 使用受控 `DeviceAccess` 验证 UTF-8 限额、字段原样、能力准入、结果解码、日志、取消和晚到响应。该测试不代表真实 Android 设备、ADB Keyboard 安装、目标应用文字插入或产品界面验收。
