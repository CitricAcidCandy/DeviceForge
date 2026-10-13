# APKS高级匹配插件实施裁定

日期：2026年10月12日。主代理已批准本批兼容可选字段、纯公共核心及两插件私有接线。采用architecture-first、Hybrid；后端开发不改宿主设备分支、domain/splits、旧别名、生成文件或公共会话，测试并行，普通缺陷集中回流。

## 官方依据与实际职责

固定官方bundletool 1.3.0提交为`a380c5bbb841bb39f3e1cccbca1bd743b0dfbf66`，本次实际读取[devices.proto](https://github.com/google/bundletool/blob/a380c5bbb841bb39f3e1cccbca1bd743b0dfbf66/src/main/proto/devices.proto)、[ExtractApksCommand](https://github.com/google/bundletool/blob/a380c5bbb841bb39f3e1cccbca1bd743b0dfbf66/src/main/java/com/android/tools/build/bundletool/commands/ExtractApksCommand.java)和[InstallApksCommand](https://github.com/google/bundletool/blob/a380c5bbb841bb39f3e1cccbca1bd743b0dfbf66/src/main/java/com/android/tools/build/bundletool/commands/InstallApksCommand.java)。提取支持modules与instant；安装仅支持modules，不虚构安装instant或请求自选设备规格。

真实toc.pb匹配、依赖模块展开、纹理压缩及设备档位目标解释继续归受信任bundletool。新增公共核心只负责严格设备规格/模块规则及纯camelCase映射，不称本工程自主解析toc或实现全部匹配算法。实际部署JAR版本未在本批探测或运行，官方参数证据不替代部署工具、真实包或真机验收。

## 兼容合同

现有`plugin.android-packages.extract_splits`及`plugin.android-device.app.install_apks`/`app.install_apks@1`增加可选输入，贡献数量仍为七项与十二项。旧四字段设备规格、原请求默认argv、原结果与预算保持；未配置高级字段不生成额外参数或JSON键。

| 位置 | 新字段 | 缺省与限额 |
| --- | --- | --- |
| 提取`device_spec` | `device_features`、`gl_extensions` | 缺省空列表；各最多256项、每项160字节、唯一ASCII字母/数字/`_.:-`标识；显式null拒绝 |
| 提取`device_spec` | `codename`、`device_tier` | 缺省None；允许null；有值时1至80字节ASCII字母/数字/`_-`；档位为字符串而非整数 |
| 提取顶层 | `modules` | 缺省None或null，不传参数；有值1至128唯一模块，单独`ALL`合法 |
| 提取顶层 | `instant` | 缺省false；必须布尔，仅true追加固定`--instant` |
| 安装嵌套`input` | `modules` | 与提取相同；不接instant或device_spec |

普通模块1至80字节，首字符字母，其余ASCII字母/数字/下划线；拒绝空列表、重名、路径、选项和逗号，拒绝ALL与具体模块混用。模块顺序保留为一个独立`--modules=base,feature_1`参数。全部设备规格字符串累计最多48KiB，使私有JSON保持在既有65536字节写入限额内，超限失败，不截断。

标准ABI/语言、密度及SDK数值仍遵守原16/100项、每项80字节和1至10000边界。映射为官方`deviceFeatures`、`glExtensions`、`codename`与`deviceTier`；缺省项省略，四字段序列化经原JSON值路径保持原字节排列。高级输入由完整插件贡献提交，旧alias/domain请求未扩写，不能宣称旧别名已接受这些新字段。

## 文件与责任

| 写集 | 职责 |
| --- | --- |
| `android-package-core/src/apks/` | 公开DeviceSpec/Selection、受原Control约束的纯规则、借用可序列化映射及回归 |
| `android-packages/operations/input` | 严格可选字段，委托公共规则，旧输入与默认结果兼容 |
| `android-packages/operations/extract_splits` | 原Session/worker和归档预检，固定JSON/argv，原监测/打包/发布 |
| `android-device/operations`及私有APKS接线 | 严格嵌套modules，保持APK字段资格，原输入副本/Java租约/清理流程 |
| 三份公开清单及所属说明 | 兼容可选模式；AndroidDevice双清单逐字节保持一致 |

主代理独占公共库`lib.rs`出口、workspace/架构/生成和根交付记录。未增加库依赖、工具探测、设备锁、临时资源类型或清理预算。实际资格、原总期限、合作取消、输入稳定副本、进程与目录物理清理继续由已有插件Session负责；安装完成不承诺设备事务回滚、共享daemon或完整派生进程树回收。

## 本批冻结与验证

主代理接入公共库出口后，实际核心6、包插件22、设备插件75，合计103项库测试通过，原件`artifacts/apks-advanced-integrated-lib-20261012.txt`。相关全目标Clippy退出0，原件`artifacts/interactive-apks-targeted-clippy-20261012.txt`。前端高级可选项新增9项在主代理当前源码定点验证通过，`artifacts/frontend-apks-options-delta-20261012.txt`；旧前端413冻结快照不包含这9项，不能借记为当前全量门禁。

上述证明严格输入、兼容缺省、固定映射/argv及基础消费。高级实际Java/JAR、真实APKS、HTTP/MCP服务与设备匹配、正式包/npx及真机仍待。

初次冻结已写新增16项回归：核心6项、提取固定JSON/argv3项、提取严格输入3项、安装严格输入2项、安装默认/模块argv2项。现有测试仅补必要的新枚举字段，不接手独立协议/服务写集。当时尚未运行Cargo、真实Java或服务；修后实际Cargo结果见本节最新记录，真实Java和服务仍待。

三清单JSON可解析，两个AndroidDevice清单逐字节一致，提取/安装可选字段位置已静态核对。首次对比暴露示例清单UUID模式漏掉一个四位组，已窄修为原规范模式，复验退出0；不把首次失败改写为通过。

必要后续：核心/两插件定点库与Clippy、既有独立协议兼容、HTTP/MCP高级完整贡献、真实工具固定参数、正式包/npx、真实APKS和设备匹配。字段映射或固定argv回归不等同真实匹配成功，普通缺陷按冻结项回流，不阻塞下一独立研发。
