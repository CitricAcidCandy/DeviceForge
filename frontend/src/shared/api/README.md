# 后端接口类型

作用：生成契约、类型端点、运行校验与真实异步 HTTP 适配。types.ts 直接推导 paths，validation.ts 校验未知业务数据；client.ts 负责包装/错误/取消，endpoints.ts 负责请求路径与序列化。

快速开始：`npm run generate:api`；脚本通过后端导出程序生成 `generated.ts`，不需要启动服务器或访问令牌。API 类型按路径、方法、请求及响应检索；禁止手工修改生成文件。

`createApiClient({baseUrl, transport, tokenProvider?})` 注入 fetch 与可选令牌；`call(endpoint,input,signal)` 返回 `{data,logId}`，错误为 ApiError 的 http/network/cancelled/protocol。v2 包装/关联头不一致拒绝；没有自动重试或管理重放。令牌只进请求头，禁止重定向携带令牌。

uploadEndpoint 上传原始 Blob，downloadArtifact 保留包括 JSON 在内的原字节与响应头日志 ID。abortable 即使依赖忽略信号也及时结束客户端等待。公开标识按单路径段编码，分页参数验证非负安全整数。网络异常不携带原文。业务成功/错误必须为 v2 包装；未实现 v1 运行客户端或任意通用 URL 请求。
