// 仅验收探针保存公开上下文；不导入宿主私有模块，也不提供产品页面。
const id = 'task_history_browser_probe';
const key = Symbol.for('deviceforge.task-history-browser.probe');
const moduleIdentity = import.meta.url;
let probe;

function panel(panelId) {
  return { id: panelId, title: '任务历史作用域验收 ' + panelId, async mount(target, context) {
    const node = target.ownerDocument.createElement('span');
    node.textContent = '任务历史验收探针'; target.append(node);
    const entry = { context, disposed: false, releases: 0 };
    probe.panels[panelId] = entry;
    context.onDispose(() => { entry.disposed = true; });
    return () => { entry.releases += 1; node.remove(); };
  } };
}

export default {
  id, version: '1.0.0', apiVersion: 2, panels: [panel('left'), panel('right')],
  async activate(context) {
    if (!context.taskHistory) throw new Error('生产公开上下文未装配 taskHistory');
    probe = { context, moduleIdentity, disposed: false, panels: {} };
    globalThis[key] = probe;
    context.onDispose(() => { probe.disposed = true; });
  },
};
