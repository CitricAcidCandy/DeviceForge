import assert from 'node:assert/strict';

// 仅模拟公开 DOM 和 SDK 对象，测试不加载浏览器或宿主实现。
export class Element {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = '';
    this.disabled = false;
    this.parent = null;
  }
  append(...children) {
    for (const child of children) { this.children.push(child); child.parent = this; }
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) {
    const group = this.listeners.get(name) ?? new Set();
    group.add(listener);
    this.listeners.set(name, group);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  click() { if (!this.disabled) for (const listener of this.listeners.get('click') ?? []) listener(); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

export function fixture({ debug = false, submit, getJob } = {}) {
  const document = { createElement: (tag) => new Element(document, tag) };
  const target = document.createElement('main');
  const lifetime = new AbortController();
  const releases = [];
  const nodes = [];
  const resources = [];
  const events = [];
  const context = {
    apiVersion: 2, signal: lifetime.signal,
    submit: submit ?? (async () => ({ data: { id: 'job-1', status: 'succeeded', result: { message: '回显' } }, logId: 'submit-log' })),
    getJob: getJob ?? (async () => { throw new Error('不应查询已终态任务'); }),
    cancelJob: async () => { throw new Error('本地释放不应隐式取消服务器任务'); },
    onDispose(callback) {
      let done = false;
      const release = async () => { if (!done) { done = true; await callback(); } };
      releases.push(release);
      return release;
    },
  };
  if (debug) context.debug = {
    registerNode(definition) {
      assert.ok(!nodes.some((node) => node.id === definition.id));
      const node = { ...definition, disposed: 0, updates: [] };
      nodes.push(node);
      return { id: definition.id, update: (next) => node.updates.push(next), dispose: () => node.disposed++ };
    },
    emit: (event) => events.push(event),
    registerResource(definition, release) {
      assert.ok(!resources.some((item) => item.id === definition.id));
      const item = { ...definition, released: 0 };
      resources.push(item);
      return () => { item.released++; return release(); };
    },
  };
  return { context, target, nodes, resources, events, lifetime,
    async dispose() { lifetime.abort(new Error('测试作用域已撤销')); for (const release of releases) await release(); } };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
