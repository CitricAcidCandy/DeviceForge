# AAB 构建领域端口
BuildApksRequest 限定产物 UUID 与 default / universal 模式，BuiltApks 保存新产物、APK 数量和通用条目。BundleBuilder 可替换，不依赖进程、路径、密钥配置或 HTTP；请求不携带服务器工具参数。领域验证与生成模式共用类型，未知字段拒绝。