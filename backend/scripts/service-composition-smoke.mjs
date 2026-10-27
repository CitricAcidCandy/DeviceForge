import { run } from './service-composition/run.mjs';

// 本入口只消费主代理预构建产物；不运行 Cargo、npm 或额外 MCP 实例。
await run(process.argv.slice(2));
