# 浏览器插件清单

浏览器包需要 `package.json`、由其引用的 `plugin.json` 以及已构建的 ESM 入口。三处插件版本应保持一致；插件清单 `api_version` 与入口对象 `apiVersion` 均为 2。`package.json.name` 是 npm 包名，可以不同于插件 ID；身份以 `plugin.json.id` 和入口默认导出对象的 `id` 为准，两者必须相同。

## package.json

```json
{
  "name": "deviceforge-browser-guide-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "files": ["plugin.json", "src"],
  "deviceforge": {
    "kind": "browser",
    "manifest": "plugin.json",
    "entrypoints": {
      "any": { "runtime": "browser", "path": "src/index.js" }
    }
  }
}
```

`deviceforge.kind` 固定为 `browser`。浏览器入口采用 `entrypoints.any`，其 `runtime` 固定为 `browser`，`path` 指向包内存在的 JavaScript 模块。不要把 TypeScript、TSX、CommonJS 或仅存在于开发机的文件声明为可直接执行入口。`type: module` 也使 Node 语法检查和本地导入按 ESM 解释 `.js`。

`manifest` 和 `path` 均相对包根；使用 `/` 分隔的相对路径，不使用盘符、绝对路径、`..`、网络 URL 或指向包外的链接。npm TGZ 的标准外层 `package/` 由解包器识别；不要把 `package/` 写进入口路径。文件是否进入归档由实际打包结果确认，`files` 只是 npm 的打包配置。

## plugin.json

```json
{
  "id": "browser_guide_example",
  "version": "0.1.0",
  "api_version": 2
}
```

插件 ID 使用 `^[a-z][a-z0-9._-]{0,99}$`。入口导出 `id/version/apiVersion/panels`；即使没有面板，`panels` 也要提供空数组。`activate`、`deactivate`、`contributions` 可省略。版本须为非空字符串，建议保持语义版本，并与包和清单一致。

## 贡献标识与可选字段

面板、组件、模块、命令、服务、钩子和主题 ID 必须以 `<插件ID>.` 开头，并匹配 `^[a-z][a-z0-9._-]{0,199}$`。贡献 ID 不得重复；模块路由也不得与其他已登记模块冲突。标题必须非空。模块 `route` 必须以 `/` 开头，不能以 `//` 开头，不能包含 `?`、`#` 或反斜线。

可选字段应按需省略：`components.mode` 缺省为 `append`，支持 `replace`；`beforeTaskSubmit.priority` 是可选安全整数；服务 `version` 为非空精确匹配字符串，不代表宿主支持 semver 范围；主题可选 `variables/css/colorScheme`。不要为未知字段凭空创造权限、依赖安装或后台能力声明。

SDK 2 的 `extensions/devices/artifacts/taskHistory/themes` 是可选上下文字段；不能通过清单强制让旧宿主获得这些能力。运行时先检查所需字段，再查询实际服务或设备能力。
