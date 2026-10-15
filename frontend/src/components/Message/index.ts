// 无JSX的公共消息入口供装配与Node测试消费，不加载浏览器展示组件。
export { createMessageController } from './controller.ts';
export type {
  GlobalMessage,
  MessageController,
  MessageDetail,
  MessageLevel,
  MessageOptions,
} from './types.ts';
