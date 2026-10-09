# 便携插件包类型

`PortablePackage/PackageDescriptor/PackageEntrypoint` 对应 `package.json.deviceforge`，兼容 npm 的其他 package.json 字段；声明本身不接受额外执行器字段。`PortableServerManifest` 保留协议 1/2/3、操作、产物和性能声明，但不接受机器 executable。`BrowserManifest` 只定义 id/version/api_version，当前宿主接受 API 2。

SDK 只提供序列化契约，不运行包脚本、不解析服务器路径、不加载模块，也不依赖宿主层。native/node/browser 的入口由各宿主基于公开便携声明映射。
