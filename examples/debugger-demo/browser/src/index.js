import { inputSchema, outputSchema, localEcho, serverEcho } from './echo.js';
import { mount } from './mount.js';
import { registerDemoData } from './data-source.js';

// 原生 ESM 直接消费公开 SDK 对象契约，无类型路径、裸包名或运行时 SDK 依赖。
const id = 'demo.debugger.browser';
export default {
  id, version: '1.0.0', apiVersion: 2,
  async activate(context) { registerDemoData(context); },
  panels: [{ id: `${id}.panel`, title: '独立回显面板', mount }],
  contributions: {
    components: [
      { id: `${id}.append`, title: '回显追加示例', slot: 'developer.tools', mode: 'append', mount },
      { id: `${id}.replace`, title: '回显页面替换示例',
        slot: 'page.demo.debugger.browser.echo', mode: 'replace', mount },
    ],
    modules: [{ id: `${id}.page`, title: '独立回显示例', route: '/echo', mount }],
    commands: [{ id: `${id}.server-echo`, title: '提交服务器回显', execute: serverEcho }],
    services: [{ id: `${id}.echo`, version: '1', inputSchema, outputSchema, invoke: localEcho }],
  },
};
