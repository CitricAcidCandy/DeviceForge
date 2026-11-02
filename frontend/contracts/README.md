# DeviceForge 公开接口契约

本开发包只包含从 Rust 公开 OpenAPI 同步的 TypeScript 类型，不含宿主实现、浏览器请求器、业务规则或 React。

插件通过 `import type { paths, components } from '@deviceforge/contracts/api'` 索引公开接口；实际通信使用 SDK 的公开传输能力并校验未知响应。类型不能代替运行时校验，也不能证明旧服务器已经支持新增接口。

`api.d.ts` 是派生产物，不手工编辑。宿主维护者同步已有生成结果后打包；第三方开发者只安装实际提供的本地归档，无需运行宿主生成器。当前包没有 registry 发行地址，不应把包名当作已公开发布。
