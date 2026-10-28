import { serverEcho } from './echo.js';

let sequence = 0;

// 同一插件可同时出现在面板、追加组件、替换组件和模块中；每次挂载单独持有资源。
export async function mount(target, context) {
  const id = `demo.debugger.browser.mount-${++sequence}`;
  const document = target.ownerDocument;
  const root = document.createElement('section');
  root.setAttribute('aria-label', '独立回显示例');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '提交服务器回显';
  button.dataset.deviceforgeAction = 'local';
  const output = document.createElement('output');
  output.setAttribute('aria-label', '回显状态');
  output.textContent = '尚未提交；请先启用配套服务器插件';
  root.append(button, output);
  target.append(root);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  let closed = false;
  let busy = false;
  let node;
  let releaseResource;

  const click = () => {
    if (closed || busy || signal.aborted) return;
    busy = true;
    button.disabled = true;
    output.textContent = '等待原回显任务终态';
    context.debug?.emit({ name: 'echo_submitted', nodeId: node?.id, metadata: { source: '示例按钮' } });
    void serverEcho({ message: '独立工程回显' }, context, signal).then((result) => {
      if (closed || signal.aborted) return;
      output.textContent = JSON.stringify(result.data);
      node?.update({ role: 'status', label: '回显已成功', metadata: { job_id: result.data.job.id } });
      context.debug?.emit({ name: 'echo_succeeded', nodeId: node?.id,
        metadata: { job_id: result.data.job.id, log_id: result.logId } });
    }, (error) => {
      if (!closed && !signal.aborted) {
        output.textContent = `${error.message ?? '回显失败'}；日志 ID：${error.logId ?? '未取得'}`;
      }
    }).finally(() => {
      busy = false;
      if (!closed && !signal.aborted) button.disabled = false;
    });
  };
  const releaseOwned = () => {
    lifetime.abort(new Error('本次挂载已结束；只取消本地等待'));
    button.removeEventListener('click', click);
  };
  const dispose = async () => {
    if (closed) return;
    closed = true;
    releaseOwned();
    try { await releaseResource?.(); }
    finally { node?.dispose(); root.remove(); }
  };
  try {
    signal.throwIfAborted();
    node = context.debug?.registerNode({ id: `${id}.status`, role: 'status', label: '独立回显状态',
      metadata: { operation: 'plugin.demo_debugger_server.echo' } });
    button.addEventListener('click', click);
    releaseResource = context.debug?.registerResource({ id: `${id}.listener`, kind: 'event-listener',
      label: '回显按钮监听与本地等待' }, releaseOwned);
    context.debug?.emit({ name: 'echo_mounted', nodeId: node?.id, metadata: { scope: id } });
    // 公开 onDispose 返回登记后的释放函数，手动卸载和作用域结束共用同一条幂等清理路径。
    return context.onDispose(dispose);
  } catch (error) {
    await dispose();
    throw error;
  }
}
