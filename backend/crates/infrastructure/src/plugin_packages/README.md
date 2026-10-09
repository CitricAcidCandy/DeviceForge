# 有界插件包文件适配器

构造 `FilePluginPackages::open(server_root: &Path, browser_root: &Path, node_binary: Option<PathBuf>) -> Result<Self>`。服务器根目录必须与 FilePluginCatalog 的部署根相同；浏览器使用独立根目录。Node 程序只来自管理员构造参数，未指定时由宿主 PATH 解析；包不能选择机器程序。

上传最多 64 MiB，解包总量最多 256 MiB，单文件最多 64 MiB，条目最多 4096，清单最多 64 KiB，安装总期限 120 秒。准备工作最多 2 个，文件工作池最多 2 个，静态读取最多 8 路；已安装列表最多 256 项。每个根目录持有独占部署锁，暂存与发布在同一卷。

`archive` 负责 ZIP/TGZ 有界展开，`paths` 负责相对路径/链接/边界，`manifest` 负责便携声明与 ProcessPlugin 映射，`storage` 负责发布和读取。拒绝绝对路径、越界、反斜杠、设备名、链接、重复文件及不完整归档。暂存结果由资源守卫拥有，错误与取消均清理本次目录。

发布只采用目录原子重命名；不覆盖同 ID，不执行安装脚本，不访问 npm registry。在线包必须自带依赖。本模块只管理可信代码部署，不宣称进程隔离或常驻会话。
