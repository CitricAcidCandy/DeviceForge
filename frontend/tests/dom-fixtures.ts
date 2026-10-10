import { JSDOM } from 'jsdom';

// 类型化 DOM 只验证节点所有权和释放；真实浏览器由独立驱动验收。
export function dom(): HTMLDivElement {
  return new JSDOM('<!doctype html><html><body></body></html>').window.document.createElement('div');
}

export function children(root: HTMLElement): HTMLElement[] {
  const elementType = root.ownerDocument.defaultView?.HTMLElement;
  if (!elementType) throw new Error('测试 DOM 缺少窗口');
  return Array.from(root.children).filter((child): child is HTMLElement => child instanceof elementType);
}
