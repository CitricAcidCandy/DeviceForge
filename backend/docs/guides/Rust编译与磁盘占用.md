# Rust 编译与磁盘占用

## 默认策略

`backend/Cargo.toml` 的工作区配置覆盖宿主及工作区插件。`resource-server/Cargo.toml` 是独立工程，单独定义相同的开发与测试策略。无需改变现有构建、测试或启动命令。

| 配置项 | 开发与测试取值 | 目的与代价 |
| --- | --- | --- |
| `debug` | `0` | 不生成调试信息，减少目标文件、库及调试文件体积；默认不支持完整源码单步和局部变量查看 |
| `incremental` | `false` | 不生成新的 Rust 增量编译缓存；修改后的重编译可能更慢 |
| `codegen-units` | `16` | 明确采用关闭增量编译时的常规分片数，不沿用增量编译默认的 256 个分片 |

开发断言、整数溢出检查和优化级别保持 Cargo 原默认值。没有改动 `release` 配置、生产接口、运行中部署或插件协议，也没有开启自动删除。

## 需要源码级调试时

以下命令从项目根目录执行，仅对本次命令覆盖配置，不修改清单或长期环境变量：

```powershell
cargo --config 'profile.dev.debug=2' build --manifest-path backend/Cargo.toml -p apk-server
cargo --config 'profile.test.debug=2' test --manifest-path backend/Cargo.toml -p apk-domain --lib
cargo --config 'profile.dev.debug=2' build --manifest-path resource-server/Cargo.toml
```

临时开启调试信息仍保持增量编译关闭。不要为了节省磁盘关闭断言或溢出检查，也不要频繁切换工具链、目标平台、特性和编译选项：不同输入可能保留不同编译产物。

用户级 Cargo 配置、命令行 `--config`、`CARGO_INCREMENTAL` 和 `CARGO_PROFILE_*` 环境变量能够覆盖清单。发现增量目录仍持续增长时，先核对实际运行命令及覆盖配置，不以清单存在就认定每个外部构建都已采用该策略。

## 已有空间与验证边界

- 关闭增量编译只阻止后续构建继续生成相应缓存，不会回收已有 `target/debug/incremental`，也不会主动删除历史指纹、测试程序、库和调试文件。
- Cargo 的本地 `target` 目录没有因本配置获得固定容量上限；工具链、特性或目标切换后的旧产物仍需按需清理。全局下载缓存的自动清理不能替代本地构建目录管理。
- 清理前确认所有构建、调试和直接使用目标目录内程序的进程已退出；只处理可归属的编译缓存，不删除源码、设计稿、用户数据、运行部署和历史验收原件。
- `artifacts/` 的冻结包、运行副本、失败报告和截图不属于增量缓存；本次配置不为它们定义自动过期或删除策略。
- 首次采用新配置需要重新编译，旧配置对应的产物在清理前可能与新产物并存。配置验证、实际构建、功能测试和清理后磁盘变化分别报告，不从配置推断已经释放空间或整体业务验收通过。
