# 操作基础用例

公开入口 `index.ts` 提供独立 list 与目录 refresh/snapshot/subscribe/dispose。refresh 只发布最新代际，插件管理后由 app 重新刷新目录；不硬编码设备平台，不导入其他功能。没有推送服务或 UI。
