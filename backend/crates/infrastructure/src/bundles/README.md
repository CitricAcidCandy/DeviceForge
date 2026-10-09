# bundletool 构建适配器
AndroidBundles 将已上传 AAB 复制并验证后交给管理员 bundletool。BundleSigning 只接收管理员文件路径与别名，密码通过 file: 参数交给工具；缺少配置明确失败，没有调试签名回退。整个流程限 120 秒，直接进程取消与丢弃清理、输出体积监测和发布前检查分离。

validation.rs 完整读取外层 APKS 条目验证 CRC、长度、路径、重复条目及 256 MiB 展开上限，要求 toc.pb / APK 布局，通用模式要求唯一 universal.apk；不解析 toc.pb 或验证内部签名。最终产物最多 64 MiB；轮询不是硬磁盘配额，完整派生进程树回收仍待实现。

关键测试：cargo test -p apk-infrastructure bundles。fixtures/bundletool.rs 是独立模拟工具，真实 argv 和取消测试不代表真实 AAB 构建及真机验收。详细契约见 backend/docs/AAB构建接口.md。