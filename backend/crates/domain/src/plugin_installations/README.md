# 统一发布领域

本模块定义 release.json、安装计划、持久发布视图、资源绑定以及可替换安装存储端口。validation 只处理纯规则：身份、版本、平台、大小、摘要、相对路径和 JSON Pointer；不进行网络、磁盘或进程操作。requirements 表示用户必要输入，tools.bindings 表示宿主工具默认路径，二者不写入配置原值。

完整跨层接线见后端 docs/contracts/统一插件安装v1.md。新增公开字段后由主程序生成器同步客户端类型。
