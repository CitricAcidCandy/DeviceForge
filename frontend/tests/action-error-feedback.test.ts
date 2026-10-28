import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describeActionError } from '../src/app/product/error-feedback.ts';
import { createMessageController } from '../src/components/Message/index.ts';
import type { MessageOptions } from '../src/components/Message/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { TaskRecord } from '../src/shared/jobs/index.ts';

const loader = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) return {
      shortCircuit: true,
      format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    };
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    return nextLoad(url, context);
  },
});
const { useAction } = await import('../src/app/product/hooks.ts');
const { ErrorNotice } = await import('../src/app/product/feedback.tsx');
const { MessageProvider } = await import('../src/components/Message/index.tsx');

function task(status: TaskRecord['status'] = 'failed', error: string | null = null): TaskRecord {
  return { id: 'task-start', operation: 'plugin.android-device.app.start', status, result: null, error };
}

function clickRefresh(options: MessageOptions): void {
  assert.equal(options.action?.label, '刷新页面');
  let refreshes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { location: { reload() { refreshes++; } } },
  });
  try {
    options.action?.onClick();
    assert.equal(refreshes, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

async function withFeedback(
  run: (context: {
    messages: ReturnType<typeof createMessageController>;
    action(): ReturnType<typeof useAction>;
    notice(error: unknown): Promise<void>;
  }) => Promise<void>,
) {
  const browser = new JSDOM('<!doctype html><html><body><main id="feedback"></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    HTMLElement: windowRef.HTMLElement, Element: windowRef.Element, Node: windowRef.Node,
    HTMLButtonElement: windowRef.HTMLButtonElement, DocumentFragment: windowRef.DocumentFragment,
    MutationObserver: windowRef.MutationObserver, Event: windowRef.Event, CustomEvent: windowRef.CustomEvent,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const target = windowRef.document.getElementById('feedback');
  assert.ok(target);
  const root = createRoot(target);
  const messages = createMessageController();
  let current: ReturnType<typeof useAction> | undefined;
  function Probe() {
    current = useAction();
    return null;
  }
  async function notice(error: unknown) {
    await act(async () => root.render(createElement(MessageProvider, {
      controller: messages,
      children: [createElement(Probe, { key: 'probe' }), createElement(ErrorNotice, { key: 'error', error })],
    })));
  }
  try {
    await notice(null);
    await run({ messages, action() { assert.ok(current); return current; }, notice });
  } finally {
    await act(async () => root.unmount());
    messages.dispose();
    browser.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('动作钩子将过期提供者解释为可主动刷新的旧引用，不只展示原始冲突', async () => {
  await withFeedback(async ({ action, messages }) => {
    const error = new HostError('protocol', 'conflict', '设备提供者运行代次已变化', 'conflict-log', 409);
    let executions = 0;
    await act(async () => action().run(async () => { executions++; throw error; }));
    const notice = messages.snapshot()[0];
    assert.ok(notice);
    assert.equal(notice.title, '设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备');
    assert.match(notice.description ?? '', /刷新页面/);
    assert.equal(notice.action?.label, '刷新页面');
    assert.equal(notice.logId, 'conflict-log');
    assert.ok(notice.details?.some((item) => item.message === error.message));
    clickRefresh(notice);
    assert.equal(executions, 1);
    assert.equal(action().error, error);
  });
});

test('错误通知区分任务失败与查询成功，保留具体依赖错误和两种日志归属', async () => {
  await withFeedback(async ({ notice, messages }) => {
    const reason = '依赖执行失败：工具依赖失败：ADB客户端执行失败，请检查部署配置';
    await notice(new JobFailure(task('failed', reason), 'submit-log', 'query-log'));
    const message = messages.snapshot()[0];
    assert.ok(message);
    assert.equal(message.title, '设备连接工具执行失败，目前无法确认具体原因，请查看任务详情');
    assert.match(message.description ?? '', /先处理/);
    assert.equal(message.action, undefined);
    assert.equal(message.logId, 'query-log');
    assert.ok(message.details?.some((item) => item.message === reason));
    assert.ok(message.details?.some((item) => item.message === 'task-start'));
    assert.ok(message.details?.some((item) => item.label === '提交请求日志' && item.logId === 'submit-log'));
    assert.ok(message.details?.some((item) => item.label === '任务响应日志' && item.logId === 'query-log'));
  });
});

test('已提交任务的等待取消不静默丢失，也不宣称服务器任务已取消', async () => {
  await withFeedback(async ({ action, messages }) => {
    const error = new JobWaitFailure(task('running'), 'submit-log', null,
      new ApiError('cancelled', 'cancelled', '任务等待已取消'), 'last-query-log');
    await act(async () => action().run(async () => { throw error; }));
    const notice = messages.snapshot()[0];
    assert.ok(notice);
    assert.equal(notice.title, '已停止等待任务');
    assert.equal(notice.level, 'info');
    assert.match(notice.description ?? '', /未确认.*取消/);
    assert.match(notice.description ?? '', /不要.*重复提交/);
    assert.equal(notice.logId, 'last-query-log');
  });
});

test('HTTP与SDK过期冲突都保留诊断，刷新回调只在用户点击后执行', () => {
  const errors = [
    new ApiError('http', 'conflict', '设备提供者运行代次已变化', 409, 'http-log'),
    new HostError('protocol', 'conflict', '设备提供者运行代次已变化', 'host-log', 409),
  ];
  for (const error of errors) {
    let refreshes = 0;
    const feedback = describeActionError(error, () => { refreshes++; });
    assert.equal(feedback.title, '设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备');
    assert.equal(feedback.options.logId, error.logId);
    assert.ok(feedback.options.details?.some((item) => item.message === 'conflict'));
    assert.ok(feedback.options.details?.some((item) => item.message === '409'));
    assert.equal(refreshes, 0);
    assert.equal(feedback.options.action?.label, '刷新页面');
    feedback.options.action?.onClick();
    assert.equal(refreshes, 1);
    assert.doesNotMatch(feedback.options.description ?? '', /已刷新|已清理|自动重试/);
  }
});

test('普通409资源占用、离线或未授权不误判成需要页面升级', () => {
  for (const message of ['资源正被其他任务使用', '设备不在线或尚未授权', '设备提供者尚无本代观测目录']) {
    const feedback = describeActionError(new ApiError('http', 'conflict', message, 409, 'busy-log'), () => {
      assert.fail('普通冲突不能触发页面刷新');
    });
    assert.equal(feedback.title, message === '设备提供者尚无本代观测目录'
      ? '尚未获取此插件的设备列表，请先重新获取设备列表' : message);
    assert.equal(feedback.options.action, undefined);
    assert.doesNotMatch(feedback.options.description ?? '', /升级|页面.*落后/);
    assert.ok(feedback.options.details?.some((item) => item.message === message));
  }
});

test('实际原因直接显示在标题，不把应用未安装藏进依赖错误详情', () => {
  const reason = '当前设备未安装此应用，请选择已安装应用，或先完成安装';
  const error = new JobFailure(task('failed', `依赖执行失败：应用启动失败：${reason}`),
    'submit-log', 'query-log');
  const feedback = describeActionError(error, () => assert.fail('未安装不是页面升级'));
  assert.equal(feedback.title, reason);
  assert.doesNotMatch(feedback.options.description ?? '', /检查插件依赖与部署配置/);
  assert.equal(feedback.options.action, undefined);
  assert.ok(feedback.options.details?.some((item) => item.message.includes('应用启动失败')));
});

test('实际原因直接显示普通业务错误，不用状态码概括掉服务说明', () => {
  const error = new ApiError('http', 'conflict', '资源正被其他任务使用', 409, 'resource-log');
  const feedback = describeActionError(error, () => {});
  assert.equal(feedback.title, error.message);
  assert.equal(feedback.options.logId, 'resource-log');
  assert.equal(feedback.options.action, undefined);
});

test('旧服务的内部术语显示为可理解原因，技术原文只保留在详情', () => {
  for (const [original, expected] of [
    ['设备提供者代际已变化', '设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备'],
    ['设备提供者尚无本代观测目录', '尚未获取此插件的设备列表，请先重新获取设备列表'],
    ['设备贡献已撤销', '设备插件已停止提供这项功能，请更新设备列表后重试'],
    ['服务提供者代际已变化', '提供这项功能的插件已更新，请刷新页面后重试'],
    ['性能来源代际已撤销', '性能采集使用的插件已更新或停止，请重新选择设备后开始采集'],
    ['插件资源清理未确认，请检查外部资源后再恢复', '插件结束时未能确认清理完成，请查看对应任务详情'],
    ['插件资源清理未确认', '插件结束时未能确认清理完成，请查看对应任务详情'],
    ['数据超过插件限额', '本次操作的数据超过大小上限，请缩小数据或分批处理'],
  ] as const) {
    const feedback = describeActionError(new ApiError('http', 'conflict', original, 409, 'original-log'), () => {});
    assert.equal(feedback.title, expected);
    assert.doesNotMatch(feedback.title, /代次|代际|观测|贡献已撤销/);
    assert.ok(feedback.options.details?.some((item) => item.message === original));
    assert.equal(feedback.options.logId, 'original-log');
    if (original.includes('清理')) {
      assert.doesNotMatch(feedback.title, /已恢复|已释放|不受.*影响/);
    }
  }
});

test('新服务的更新提示仍提供主动刷新，不回退到内部术语匹配', () => {
  const message = '设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备';
  let refreshes = 0;
  const feedback = describeActionError(new ApiError('http', 'conflict', message, 409, 'new-log'), () => refreshes++);
  assert.equal(feedback.title, message);
  assert.equal(feedback.options.action?.label, '刷新页面');
  assert.equal(refreshes, 0);
});

test('响应协议不兼容提供主动刷新，但本地输入错误不伪装成升级问题', () => {
  for (const error of [
    new ApiError('protocol', 'invalid_response', '业务响应不符合生成契约', 200, 'response-log'),
    new HostError('protocol', 'invalid_result', '任务结果不是 JSON 值', 'result-log'),
  ]) {
    const feedback = describeActionError(error, () => {});
    assert.equal(feedback.title, '页面无法读取服务返回的数据');
    assert.match(feedback.options.description ?? '', /可能落后/);
    assert.match(feedback.options.description ?? '', /先查询操作结果/);
    assert.equal(feedback.options.action?.label, '刷新页面');
  }
  const input = describeActionError(new ApiError('protocol', 'invalid_input', '输入字段无效'), () => {});
  assert.equal(input.title, '输入字段无效');
  assert.equal(input.options.action, undefined);
});

test('网络故障不将写操作结果未知误称为任务失败或建议重放', () => {
  const feedback = describeActionError(new ApiError('network', 'network_error', '无法取得服务器响应'), () => {});
  assert.equal(feedback.title, '暂时无法连接服务');
  assert.match(feedback.options.description ?? '', /是否已生效尚未确认/);
  assert.match(feedback.options.description ?? '', /先查询状态/);
  assert.match(feedback.options.description ?? '', /不要直接重复提交/);
  assert.equal(feedback.options.action, undefined);
});

test('无响应网络错误明确解释没有日志ID，保留原始错误且不伪造编号', () => {
  const error = new ApiError('network', 'network_error', '无法取得 MCP 服务响应');
  const feedback = describeActionError(error, () => {});
  assert.match(feedback.options.description ?? '', /未收到服务器响应，未取得日志ID/);
  assert.equal(feedback.options.logId, null);
  assert.ok(feedback.options.details?.some((detail) => detail.message === error.message));
  assert.ok(feedback.options.details?.some((detail) => detail.message === 'network_error'));
  assert.ok(feedback.options.details?.some((detail) => detail.message === '未收到服务器响应，未取得日志ID'));
  assert.equal(feedback.options.details?.some((detail) => detail.logId), false);
});

test('已有HTTP响应却缺日志ID时如实解释缺失，不谎称服务器没有响应', () => {
  const feedback = describeActionError(new ApiError('http', 'internal_error', '服务处理失败', 500), () => {});
  assert.equal(feedback.options.logId, null);
  assert.ok(feedback.options.details?.some((detail) => detail.message === '服务器响应未提供日志ID'));
  assert.doesNotMatch(JSON.stringify(feedback), /未收到服务器响应/);
});

test('等待请求没有响应仍解释本次缺日志ID，已有提交和观测日志继续保留归属', () => {
  const error = new JobWaitFailure(task('running'), 'submit-log', null,
    new ApiError('network', 'network_error', '无法取得 MCP 服务响应'), 'last-query-log');
  const feedback = describeActionError(error, () => {});
  assert.equal(feedback.options.logId, 'last-query-log');
  assert.ok(feedback.options.details?.some((detail) => detail.message === '未收到服务器响应，未取得日志ID'));
  assert.ok(feedback.options.details?.some((detail) => detail.label === '提交请求日志' && detail.logId === 'submit-log'));
  assert.ok(feedback.options.details?.some((detail) => detail.label === '最近任务观测日志' && detail.logId === 'last-query-log'));
  assert.equal(feedback.options.details?.some((detail) => detail.label === '等待中断请求日志'), false);
});

test('真实网络日志ID不被缺失说明覆盖，空白编号不显示成可复制日志', () => {
  const available = describeActionError(new ApiError('network', 'network_error', '连接中断', null, 'network-log'), () => {});
  assert.equal(available.options.logId, 'network-log');
  assert.doesNotMatch(JSON.stringify(available), /未取得日志ID/);
  const missing = describeActionError(new ApiError('network', 'network_error', '无法取得响应', null, '   '), () => {});
  assert.equal(missing.options.logId, null);
  assert.match(missing.options.description ?? '', /未收到服务器响应，未取得日志ID/);
});

test('无响应消息展开详情后可见缺失原因，且没有复制空日志入口', async () => {
  await withFeedback(async ({ notice, messages }) => {
    await notice(new ApiError('network', 'network_error', '无法取得 MCP 服务响应'));
    const message = messages.snapshot()[0];
    assert.ok(message);
    const toast = document.querySelector(`[data-message-id="${message.id}"]`);
    assert.ok(toast);
    const details = toast.querySelector('details');
    assert.ok(details);
    details.open = true;
    assert.match(details.textContent ?? '', /未收到服务器响应，未取得日志ID/);
    assert.match(details.textContent ?? '', /无法取得 MCP 服务响应/);
    assert.equal(toast.querySelector('button[aria-label*="复制"]'), null);
  });
});

test('有日志ID的消息不用展开详情即可复制，原生接口完成前不报告成功', async () => {
  await withFeedback(async ({ messages }) => {
    let copied = '';
    let finish: (() => void) | undefined;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText(value: string) {
        copied = value;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    } });
    await act(async () => { messages.error('处理失败', { id: 'copy-source', logId: 'response-log' }); });
    const toast = document.querySelector('[data-message-id="copy-source"]');
    assert.ok(toast);
    const button = toast.querySelector<HTMLButtonElement>('button[aria-label="复制消息日志 ID"]');
    assert.ok(button);
    assert.equal(Boolean(button.closest('details')), false);
    assert.equal(toast.querySelector('details')?.open, false);
    await act(async () => button.click());
    assert.equal(copied, 'response-log');
    assert.equal(messages.snapshot().some((message) => message.level === 'success'), false);
    const complete = finish;
    assert.ok(complete);
    await act(async () => complete());
    assert.equal(messages.snapshot().find((message) => message.id === 'message-copy')?.title, '日志 ID 已复制');
  });
});

test('局域网HTTP缺少clipboard时用兼容复制，返回false则保留可选择的ID并明确失败', async () => {
  await withFeedback(async ({ messages }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    let copied = '';
    let succeeds = true;
    Object.defineProperty(document, 'execCommand', { configurable: true, value(command: string) {
      assert.equal(command, 'copy');
      const selected = document.activeElement;
      assert.ok(selected instanceof window.HTMLTextAreaElement);
      copied = selected.value;
      return succeeds;
    } });
    await act(async () => { messages.error('处理失败', { id: 'lan-copy', logId: 'lan-log' }); });
    const button = document.querySelector<HTMLButtonElement>('[data-message-id="lan-copy"] button[aria-label="复制消息日志 ID"]');
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(copied, 'lan-log');
    assert.equal(messages.snapshot().find((message) => message.id === 'message-copy')?.level, 'success');
    succeeds = false;
    await act(async () => button.click());
    const feedback = messages.snapshot().find((message) => message.id === 'message-copy');
    assert.equal(feedback?.level, 'warning');
    assert.equal(feedback?.title, '复制失败，请手动选择日志 ID');
    assert.equal(feedback?.logId, 'lan-log');
    const visibleId = document.querySelector('[data-message-id="lan-copy"] code');
    assert.equal(visibleId?.textContent, 'lan-log');
    assert.ok(visibleId?.classList.contains('select-text'));
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(messages.snapshot().some((message) => message.level === 'success'), false);
  });
});

test('原生剪贴板拒绝时继续兼容复制，详情中的日志仍复制各自编号', async () => {
  await withFeedback(async ({ messages }) => {
    let writes = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText() { writes++; throw new Error('拒绝访问剪贴板'); },
    } });
    const copied: string[] = [];
    Object.defineProperty(document, 'execCommand', { configurable: true, value() {
      const selected = document.activeElement;
      assert.ok(selected instanceof window.HTMLTextAreaElement);
      copied.push(selected.value);
      return true;
    } });
    await act(async () => { messages.error('任务失败', { id: 'job-copy', logId: 'query-log', details: [
      { label: '提交请求日志', message: '原始提交', logId: 'submit-log' },
    ] }); });
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="复制提交请求日志日志 ID"]');
    assert.ok(button);
    const details = button.closest('details');
    assert.ok(details);
    details.open = true;
    await act(async () => button.click());
    assert.equal(writes, 1);
    assert.deepEqual(copied, ['submit-log']);
    assert.equal(messages.snapshot().find((message) => message.id === 'message-copy')?.level, 'success');
  });
});

test('任务等待网络中断保留提交、失败查询及最近观测的三个日志归属', () => {
  const error = new JobWaitFailure(task('running'), 'submit-log', 'failed-query-log',
    new ApiError('network', 'network_error', '连接中断', null, 'failed-query-log'), 'last-query-log');
  const feedback = describeActionError(error, () => {});
  assert.equal(feedback.title, '暂时无法确认任务状态');
  assert.equal(feedback.level, 'warning');
  assert.equal(feedback.options.logId, 'failed-query-log');
  assert.equal(feedback.options.action, undefined);
  for (const [label, logId] of [
    ['提交请求日志', 'submit-log'], ['等待中断请求日志', 'failed-query-log'], ['最近任务观测日志', 'last-query-log'],
  ]) assert.ok(feedback.options.details?.some((item) => item.label === label && item.logId === logId));
});

test('任务结果不兼容仍标为待确认，保留任务ID后才建议刷新查询', () => {
  const error = new JobWaitFailure(task('running'), 'submit-log', 'query-log',
    new HostError('protocol', 'invalid_response', '返回格式不兼容', 'query-log'), 'last-query-log');
  const feedback = describeActionError(error, () => {});
  assert.equal(feedback.title, '暂时无法确认任务状态');
  assert.match(feedback.options.description ?? '', /保留任务 ID/);
  assert.match(feedback.options.description ?? '', /不要直接重复提交/);
  assert.equal(feedback.options.action?.label, '刷新页面');
});

test('服务器任务取消与前端取消等待分别说明，不宣称已回滚', () => {
  const cancelled = describeActionError(new JobFailure(task('cancelled'), 'submit-log', 'query-log'), () => {});
  assert.equal(cancelled.title, '任务已取消');
  assert.equal(cancelled.level, 'info');
  assert.match(cancelled.options.description ?? '', /不一定已回滚/);
  assert.equal(cancelled.options.action, undefined);
  const waiting = describeActionError(new ApiError('cancelled', 'cancelled', '请求等待已取消'), () => {});
  assert.equal(waiting.title, '已停止等待');
  assert.match(waiting.options.description ?? '', /尚未确认/);
});

test('通用依赖失败不会误判成刷新页面即可解决，不硬编码插件业务', () => {
  const feedback = describeActionError(new ApiError('http', 'dependency_failed', '工具依赖未就绪', 502, 'dependency-log'), () => {});
  assert.equal(feedback.title, '工具依赖未就绪');
  assert.equal(feedback.options.action, undefined);
  assert.match(feedback.options.description ?? '', /具体原因/);
  assert.doesNotMatch(feedback.options.description ?? '', /ADB|Android|鸿蒙/);
});

test('诊断只提取公开字段，不展开请求体、路径、令牌或堆栈', () => {
  const feedback = describeActionError(Object.assign(new ApiError('http', 'internal_error',
    '工具失败 C:\\private\\adb.exe；token=private-token；https://private.invalid/api?token=url-secret；/tmp/private.log', 500, 'safe-log'), {
    request: { body: 'private-body', token: 'request-token' },
    path: 'private-path',
    stack: 'private-stack',
  }), () => {});
  const serialized = JSON.stringify(feedback);
  assert.match(serialized, /已隐藏/);
  assert.doesNotMatch(serialized, /private|url-secret|request-token/);
  const unknown = describeActionError({ request: { body: 'private-body' }, token: 'private-token' }, () => {});
  assert.doesNotMatch(JSON.stringify(unknown), /private/);
});

test('错误通知重复渲染不重复发布，升级提醒使用现有消息动作', async () => {
  await withFeedback(async ({ notice, messages }) => {
    const error = new ApiError('protocol', 'invalid_response', '业务响应不符合生成契约', 200, 'response-log');
    await notice(error);
    const first = messages.snapshot()[0];
    assert.ok(first);
    assert.equal(first.action?.label, '刷新页面');
    assert.ok(first.description);
    clickRefresh(first);
    await notice(error);
    assert.equal(messages.snapshot().length, 1);
    assert.equal(messages.snapshot()[0]?.id, first.id);
  });
});

test('主动取消等待有结果未知提醒，不自动重新执行动作', async () => {
  await withFeedback(async ({ action, messages }) => {
    let executions = 0;
    let complete: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    let running: Promise<void> | undefined;
    await act(async () => {
      running = action().run(async () => { executions++; await pending; });
    });
    await act(async () => action().cancel());
    const message = messages.snapshot().find((item) => item.level === 'info');
    assert.ok(message);
    assert.match(message.description ?? '', /未确认.*取消/);
    assert.match(message.description ?? '', /不要直接重复提交/);
    complete?.();
    await act(async () => { await running; });
    assert.equal(executions, 1);
    assert.equal(messages.snapshot().filter((item) => item.level === 'success').length, 0);
  });
});

test('已有就地错误的动作保留失败与日志，不发布重复全局通知', async () => {
  await withFeedback(async ({ action, messages }) => {
    const error = new ApiError('network', 'unreachable', '无法连接服务', null, 'inline-error-log');
    await act(async () => action().run(async () => { throw error; }, {
      quiet: true,
      errorFeedback: 'inline',
    }));
    assert.equal(action().error, error);
    assert.equal(action().logId, 'inline-error-log');
    assert.equal(action().pending, false);
    assert.equal(messages.snapshot().length, 0);
  });
});

test.after(() => loader.deregister());
