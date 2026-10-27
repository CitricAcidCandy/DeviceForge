import { createFrontendRuntime, createNamedSlotAdapter } from '/__production_host__';
import { pageSlotId } from '../src/plugin-sdk/index.ts';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function resultObject(value: unknown, message: string): Record<string, unknown> {
  check(object(value), message);
  return value;
}
interface DeviceCommand {
  readonly jobId: string;
  readonly reference: {
    readonly providerId: string;
    readonly generation: string;
    readonly localId: string;
  };
}
function deviceCommand(value: unknown): DeviceCommand {
  const command = resultObject(value, '设备命令结果必须为对象');
  const reference = resultObject(command['reference'], '设备命令缺少设备引用');
  check(
    typeof command['jobId'] === 'string' &&
      typeof reference['providerId'] === 'string' &&
      typeof reference['generation'] === 'string' &&
      typeof reference['localId'] === 'string',
    '设备命令字段无效',
  );
  return {
    jobId: command['jobId'],
    reference: {
      providerId: reference['providerId'],
      generation: reference['generation'],
      localId: reference['localId'],
    },
  };
}
function browserGeneration(value: unknown): number {
  const result = resultObject(value, '浏览器启用结果必须为对象');
  check(typeof result['generation'] === 'number', '浏览器启用结果缺少运行代次');
  return result['generation'];
}
function checkText(target: HTMLElement, expected: string, message: string): void {
  check(target.textContent === expected, message);
}
function target(id: string): HTMLElement {
  const root = document.createElement('section');
  root.id = id;
  document.body.append(root);
  return root;
}
async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('真实浏览器任务等待超时');
}

// 该页面只负责运行验收，不是产品界面，也不登记夹具模块对象。
export async function verifyInstalledPlugin() {
  const signal = AbortSignal.timeout(45000);
  const panel = target('panel');
  const toolbar = target('toolbar');
  const module = target('module');
  const slot = await createNamedSlotAdapter([
    { id: pageSlotId('browser_runtime_probe', '/probe'), target: module },
    {
      id: 'toolbar',
      target: toolbar,
      renderDefault(root) {
        root.textContent = '宿主默认工具栏';
        return () => {
          root.textContent = '';
        };
      },
    },
  ]);
  const runtime = createFrontendRuntime({
    baseUrl: location.origin,
    transport: fetch.bind(globalThis),
    panelTarget: () => panel,
    moduleTarget: () => module,
    slotAdapter: slot,
    esmImporter: async (url, current) => {
      current.throwIfAborted();
      return import(/* @vite-ignore */ url);
    },
    packageEntryResolver: (info, runId) =>
      `/api/v2/browser-plugins/${encodeURIComponent(info.id)}/runs/${runId}/assets/${info.entryPath}`,
  });
  try {
    const devices = runtime.host.devices;
    check(devices, '公开宿主必须提供设备上下文');
    const archive = async (kind: 'server' | 'device' | 'browser') => {
      const response = await fetch(`/__fixture__/${kind}.tgz`, { signal });
      check(response.ok, '验收归档读取失败');
      return response.blob();
    };
    const serverPackage = await runtime.pluginPackages.upload(
      'server',
      await archive('server'),
      'application/gzip',
      signal,
    );
    const devicePackage = await runtime.pluginPackages.upload(
      'server',
      await archive('device'),
      'application/gzip',
      signal,
    );
    const installed = await runtime.pluginPackages.upload(
      'browser',
      await archive('browser'),
      'application/gzip',
      signal,
    );
    const descriptor = installed.data;
    await runtime.pluginPackages.enable('server', serverPackage.data.id, signal);
    await runtime.pluginPackages.enable('server', devicePackage.data.id, signal);
    const first = await runtime.pluginPackages.enable('browser', descriptor.id, signal);
    const firstGeneration = browserGeneration(first.data);
    await runtime.webPlugins.mount(descriptor.id, `${descriptor.id}.panel`);
    await runtime.extensions.mountComponent(`${descriptor.id}.component`);
    await runtime.extensions.mountModule(`${descriptor.id}.module`);
    checkText(panel, '在线面板已挂载', '上传包的面板未挂载');
    checkText(toolbar, '在线组件替换宿主', '上传包未替换宿主渲染');
    checkText(module, '在线模块已挂载', '上传包的模块未挂载');
    const command = await runtime.extensions.executeCommand(`${descriptor.id}.command`, {}, signal);
    const commandData = resultObject(command.data, '命令结果必须为对象');
    check(
      typeof commandData['count'] === 'number' && commandData['count'] > 0 && command.logId,
      '命令未取得真实服务器操作与日志 ID',
    );
    check(typeof commandData['dependencyRun'] === 'string', '命令缺少依赖运行标识');
    const service = await runtime.extensions.callService(
      `${descriptor.id}.service`,
      '1',
      {},
      signal,
    );
    const serviceData = resultObject(service.data, '服务结果必须为对象');
    check(serviceData['dependencyRun'] === commandData['dependencyRun'], '服务未转调当前代次命令');
    const dynamic = await runtime.extensions.executeCommand(`${descriptor.id}.dynamic`, {}, signal);
    check(
      resultObject(dynamic.data, '动态命令结果必须为对象')['ready'] === true,
      '动态注册命令未读取插件状态',
    );
    const deviceCall = await runtime.extensions.executeCommand(
      `${descriptor.id}.devices`,
      {},
      signal,
    );
    const deviceData = deviceCommand(deviceCall.data);
    const deviceResult = await eventually(
      () => runtime.tasks.get(deviceData.jobId, signal),
      (reply) => ['succeeded', 'failed', 'cancelled'].includes(reply.data.status),
    );
    const deviceJobResult = resultObject(deviceResult.data.result, '设备任务结果必须为对象');
    check(
      deviceResult.data.status === 'succeeded' && deviceJobResult['synthetic_demo'] === true,
      '公开设备任务没有取得模拟提供者的真实进程结果',
    );
    check(
      resultObject(deviceJobResult['value'], '设备任务缺少结果值')['source'] === 'browser-plugin' &&
        deviceCall.logId,
      '上传浏览器插件未通过公开设备上下文对接服务器',
    );
    const oldReference = deviceData.reference;
    await runtime.pluginPackages.disable('server', devicePackage.data.id, signal);
    check(
      !(await devices.refreshProviders(signal)).data.some(
        (item) => item.id === devicePackage.data.id,
      ),
      '提供者卸载后目录未撤销',
    );
    check(
      !(await devices.refreshDirectories(signal)).data.some(
        (item) => item.provider.id === devicePackage.data.id,
      ),
      '提供者卸载后设备目录仍有旧代',
    );
    await runtime.pluginPackages.enable('server', devicePackage.data.id, signal);
    const nextDeviceCall = await runtime.extensions.executeCommand(
      `${descriptor.id}.devices`,
      {},
      signal,
    );
    const nextDeviceData = deviceCommand(nextDeviceCall.data);
    check(
      nextDeviceData.reference.generation !== oldReference.generation,
      '设备提供者重载没有产生新代',
    );
    const nextDeviceResult = await eventually(
      () => runtime.tasks.get(nextDeviceData.jobId, signal),
      (reply) => ['succeeded', 'failed', 'cancelled'].includes(reply.data.status),
    );
    check(nextDeviceResult.data.status === 'succeeded', '新代设备能力任务未成功');
    check(
      (await runtime.tasks.get(deviceData.jobId, signal)).data.status === 'succeeded',
      '设备提供者重载丢失历史任务',
    );
    let oldDeviceRejected = false;
    try {
      await devices.invoke(
        {
          providerId: oldReference.providerId,
          generation: oldReference.generation,
          deviceId: oldReference.localId,
          capability: 'device.echo',
          version: 1,
          input: {},
        },
        signal,
      );
    } catch (error) {
      oldDeviceRejected =
        error instanceof Error &&
        'code' in error &&
        error.code === 'conflict' &&
        'status' in error &&
        error.status === 409;
    }
    check(oldDeviceRejected, '公开宿主未拒绝重载后的旧设备引用');
    // 本地规则拒绝尚未发起 HTTP；另验公开服务边界及真实服务器日志关联。
    const oldResponse = await fetch('/api/v2/device-actions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: oldReference.providerId,
        generation: oldReference.generation,
        device_id: oldReference.localId,
        capability: 'device.echo',
        version: 1,
        input: {},
      }),
    });
    const oldErrorData: unknown = await oldResponse.json();
    const oldError = resultObject(oldErrorData, '旧设备引用响应必须为对象');
    check(
      oldResponse.status === 409 &&
        resultObject(oldError['error'], '旧设备引用响应缺少错误')['code'] === 'conflict',
      '服务器未精确拒绝旧设备引用',
    );
    check(
      typeof oldError['log_id'] === 'string' &&
        oldError['log_id'] &&
        oldError['log_id'] === oldResponse.headers.get('x-deviceforge-log-id'),
      '旧引用错误缺少服务器日志 ID',
    );
    async function submit(value: number) {
      const submitted = await runtime.tasks.submit(
        { operation: 'plugin.online_echo_v2.echo', input: { message: '浏览器插件验收', value } },
        signal,
      );
      const completed = await eventually(
        () => runtime.tasks.get(submitted.data.id, signal),
        (reply) => ['succeeded', 'failed', 'cancelled'].includes(reply.data.status),
      );
      check(completed.data.status === 'succeeded', '服务器回显任务未成功');
      const completedResult = resultObject(completed.data.result, '回显任务结果必须为对象');
      const echo = resultObject(completedResult['result'], '回显任务缺少结果值');
      check(typeof echo['value'] === 'number', '回显任务返回值必须为数值');
      return { value: echo['value'], logId: completed.logId };
    }
    const transformed = await submit(4);
    check(transformed.value === 5, '插件钩子未修改真实提交参数');
    await runtime.pluginPackages.disable('browser', descriptor.id, signal);
    check(panel.childElementCount === 0 && module.childElementCount === 0, '插件停用后仍有 DOM');
    checkText(toolbar, '宿主默认工具栏', '插件停用后未恢复宿主渲染');
    const remaining = Object.values(runtime.extensions.catalog())
      .flat()
      .filter((item) => item.pluginId === descriptor.id);
    check(remaining.length === 0, '插件停用后贡献仍可发现');
    let revoked = false;
    try {
      await runtime.extensions.executeCommand(`${descriptor.id}.command`, {}, signal);
    } catch {
      revoked = true;
    }
    check(revoked, '插件停用后命令仍可调用');
    const original = await submit(4);
    check(original.value === 4, '停用后任务钩子仍然生效');
    const second = await runtime.pluginPackages.enable('browser', descriptor.id, signal);
    const nextGeneration = browserGeneration(second.data);
    const reloaded = await runtime.extensions.executeCommand(
      `${descriptor.id}.command`,
      {},
      signal,
    );
    check(nextGeneration > firstGeneration, '重载没有推进运行代次');
    const reloadedData = resultObject(reloaded.data, '重载命令结果必须为对象');
    check(
      typeof reloadedData['dependencyRun'] === 'string' &&
        reloadedData['dependencyRun'] !== commandData['dependencyRun'],
      '相对依赖命中了旧运行代次缓存',
    );
    await runtime.pluginPackages.remove('browser', descriptor.id, signal);
    await runtime.pluginPackages.remove('server', serverPackage.data.id, signal);
    await runtime.pluginPackages.remove('server', devicePackage.data.id, signal);
    check(runtime.webPlugins.snapshot().length === 0, '取消登记后仍有运行插件');
    check(
      (await runtime.pluginPackages.refresh('browser', signal)).data.length === 0,
      '浏览器部署删除后目录不为空',
    );
    check(
      (await runtime.pluginPackages.refresh('server', signal)).data.length === 0,
      '服务器部署删除后目录不为空',
    );
    return {
      passed: true,
      uploadedFromBrowser: ['server', 'browser'],
      installed: descriptor,
      firstGeneration,
      nextGeneration,
      dependencyGraphRefreshed: true,
      domMountedAndReleased: true,
      defaultRendererRestored: true,
      dynamicCommandAndState: true,
      commandAndService: true,
      beforeSubmit: [transformed.value, original.value],
      publicDeviceCapability: true,
      deviceProviderGenerationChanged: true,
      oldDeviceReferenceRejected: true,
      logIds: [
        command.logId,
        service.logId,
        dynamic.logId,
        transformed.logId,
        original.logId,
        deviceCall.logId,
        deviceResult.logId,
        oldError['log_id'],
      ],
    };
  } finally {
    await runtime.dispose();
    await slot.dispose();
  }
}
