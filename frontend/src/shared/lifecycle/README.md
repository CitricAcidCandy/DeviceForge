# 异步资源代际

`createLatestResource` 保存最新读取快照，刷新时取消上一代；即使旧传输忽略取消，晚到结果也不发布。订阅互不影响，dispose 撤销请求和订阅。不承担业务 DTO 映射或 HTTP 解析。
