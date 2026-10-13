# APKS高级规格与模块规则

公开`DeviceSpec`保留原四字段，并支持有限feature/GL扩展、codename及字符串device_tier；`validate(&Control)`复核原控制点，`bundletool()`借用映射为官方camelCase，不启动工具或解析toc.pb。`Selection`严格校验可选modules与提取instant，模块顺序保留，ALL只能单独选择。

各新增列表最多256项、单项160字节，规格文本累计48KiB；模块最多128项、单项80字节。旧默认项不序列化额外键。已有插件负责真实worker、JSON文件、固定工具argv、目录租约及合作清理；本模块没有I/O、进程、HTTP、数据库或新预算。

本批6项纯回归已写，编译和测试待主代理执行。完整字段、官方1.3.0固定提交及验证边界见[APKS高级匹配插件实施裁定](../../../../docs/APKS高级匹配插件实施裁定.md)。
