import { createRoot } from 'react-dom/client';
import { getInstanceByDom } from 'echarts/core';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import { PerformancePage } from '../src/pages/performance/index.tsx';
import { MessageProvider } from '../src/components/Message/index.tsx';
import '../src/app/styles.css';

type Fields = Record<string, unknown>;
interface RequestEvidence {
  at: string;
  method: string;
  path: string;
  action: string | null;
  status: number | null;
  logId: string | null;
}
const isRecord = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const packageId = 'com.ChillyRoom.DungeonShooter';
const allowedOperations = new Set([
  'start', 'inspect', 'samples', 'pause', 'resume', 'stop',
].map((action) => `android.performance.${action}`));
let services: ProductServices | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let ownedSession: string | null = null;
let startJob: string | null = null;
let startAttempted = false;
let selectedDevice: { providerId: string; generation: string; localId: string } | null = null;
let closing = false;
const requests: RequestEvidence[] = [];
const blocked: string[] = [];
const errors: string[] = [];
const ownedJobs = new Set<string>();

function requireServices(): ProductServices {
  if (!services) throw new Error('验收页面尚未挂载');
  return services;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function visible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === text && visible(item));
  check(found instanceof HTMLButtonElement, `未找到可见按钮：${text}`);
  check(!found.disabled, `按钮尚不可用：${text}`);
  return found;
}
async function until(test: () => boolean, name: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await wait(75);
  }
  throw new Error(`${name}等待超时`);
}
function fill(dialog: HTMLElement, text: string, value: string): void {
  const label = [...dialog.querySelectorAll('label')].find((item) => item.textContent?.trim() === text);
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  check(input instanceof HTMLInputElement, `未找到输入框：${text}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  check(setter, '浏览器原生输入接口缺失');
  // 走原生输入事件通知 React，不能直接修改组件状态或服务请求参数。
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function checked(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true';
}
async function toggle(id: string, value: boolean): Promise<void> {
  const element = document.getElementById(id);
  check(element instanceof HTMLElement && visible(element), `未找到复选框：${id}`);
  check(!element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true', `复选框不可用：${id}`);
  if (checked(element) !== value) element.click();
  await until(() => checked(element) === value, `复选框 ${id}`);
}

// 这只是转发真实请求的安全闸门；禁止发现、连接、唤醒、启动应用或任意其他设备写动作。
function auditedTransport(base: URL): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    let action: string | null = null;
    let allowed = url.origin === base.origin && request.method === 'GET';
    if (request.method === 'POST' && url.origin === base.origin) {
      const body: unknown = await request.clone().json().catch(() => null);
      if (url.pathname === '/api/v2/jobs' && isRecord(body) && typeof body['operation'] === 'string') {
        action = body['operation'];
        allowed = allowedOperations.has(action) && (!closing || action === 'android.performance.stop');
        if (action === 'android.performance.start') {
          const payload: unknown = body['input'];
          const target: unknown = isRecord(payload) ? payload['target'] : null;
          allowed = allowed && !startAttempted && isRecord(payload) && isRecord(target) &&
            target['device_id'] === selectedDevice?.localId && target['package'] === packageId &&
            payload['duration_secs'] === 45 && payload['interval_ms'] === 1000;
          if (allowed) startAttempted = true;
        }
      } else if (url.pathname === '/api/v2/device-actions' && isRecord(body)) {
        action = typeof body['capability'] === 'string' ? body['capability'] : null;
        allowed = !closing && selectedDevice !== null && action === 'screenshot' && body['version'] === 1 &&
          body['provider_id'] === selectedDevice?.providerId &&
          body['generation'] === selectedDevice?.generation &&
          body['device_id'] === selectedDevice?.localId;
      } else {
        const cancel = url.pathname.match(/^\/api\/v2\/jobs\/([^/]+)\/cancel$/);
        allowed = !!cancel?.[1] && ownedJobs.has(decodeURIComponent(cancel[1]));
        action = allowed ? '取消本轮任务' : null;
      }
    }
    if (!allowed) {
      blocked.push(`${request.method} ${url.pathname}`);
      throw new Error('已拦截超出性能验收范围的请求');
    }
    const evidence: RequestEvidence = { at: new Date().toISOString(), method: request.method,
      path: url.pathname, action, status: null, logId: null };
    // 按发起时刻计数，不能把终止前的在途响应误算成终态后的新截图。
    requests.push(evidence);
    const response = await fetch(request);
    evidence.status = response.status;
    evidence.logId = response.headers.get('x-deviceforge-log-id');
    if (request.method === 'POST' && response.ok) {
      const envelope: unknown = await response.clone().json().catch(() => null);
      if (isRecord(envelope) && isRecord(envelope['data']) && typeof envelope['data']['id'] === 'string') {
        ownedJobs.add(envelope['data']['id']);
        if (action === 'android.performance.start') startJob = envelope['data']['id'];
      }
    }
    return response;
  };
}

export async function mount(baseUrl: string) {
  check(!services, '不能重复挂载验收实例');
  const base = new URL(baseUrl);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
    '后端地址必须是不含凭据、查询或片段的 HTTP 地址');
  container = document.createElement('div');
  document.body.append(container);
  const panel = document.createElement('div');
  panel.hidden = true;
  container.append(panel);
  services = createProductServices({ baseUrl: base.href, transport: auditedTransport(base), panelTarget: () => panel });
  const signal = AbortSignal.timeout(15000);
  await services.runtime.operations.refresh(signal);
  await services.runtime.devices.refreshProviders(signal);
  await services.runtime.devices.refreshDirectories(signal);
  check(!closing && services, '公开目录返回时页面已进入释放，禁止重新挂载');
  const devices = services.runtime.devices.snapshot();
  const candidates = devices.directories.flatMap((directory) => directory.devices)
    .filter((device) => device.model === 'SM_G991U' && device.state === 'online');
  check(candidates.length === 1 && candidates[0], '公开目录必须已有且仅有一台在线 SM_G991U；不会自动发现或连接');
  selectedDevice = candidates[0].reference;
  services.runtime.devices.select(selectedDevice);
  root = createRoot(container);
  root.render(
    <MessageProvider controller={services.messages}>
      <main className="product-app flex h-dvh min-h-[640px] flex-col overflow-auto bg-[color:var(--background)] p-4 text-[color:var(--text-strong)]">
        <PerformancePage services={services} />
      </main>
    </MessageProvider>,
  );
  await until(() => document.querySelector('[data-product-page="performance"]') !== null, '生产性能页');
  return { device: candidates[0], operations: services.runtime.operations.snapshot().result?.data.map((item) => item.id) ?? [] };
}

export async function begin() {
  check(!ownedSession, '一轮验收只允许开始一次采集');
  const current = requireServices();
  button('开始采集').click();
  await until(() => document.querySelector('[role="dialog"]') !== null, '采集对话框');
  const dialog = document.querySelector('[role="dialog"]');
  check(dialog instanceof HTMLElement, '采集对话框不存在');
  fill(dialog, '应用包名', packageId);
  await wait(0);
  fill(dialog, '时长（秒）', '45');
  await wait(0);
  fill(dialog, '间隔（毫秒）', '1000');
  await toggle('collect-launch', false);
  const frames = document.getElementById('performance-live-frames');
  check(frames && !checked(frames), '采样画面必须默认关闭');
  button('开始采集', dialog).click();
  await until(() => {
    const error = current.messages.snapshot().find((message) => message.level === 'error');
    if (error) throw new Error(`${error.title}${error.logId ? `；日志 ID ${error.logId}` : ''}`);
    const session = current.runtime.performance.snapshot().session;
    if (session) ownedSession = session.id;
    return session?.state === 'running';
  }, 'DOM 开始采集', 15000);
  const session = current.runtime.performance.snapshot().session;
  check(session?.request.target.package === packageId && session.request.duration_secs === 45 &&
    session.request.interval_ms === 1000 && session.request.target.device_id === selectedDevice?.localId,
  '实际会话参数不符合 DOM 输入');
  const source = session.source?.device;
  check(source && selectedDevice && source.generation === selectedDevice.generation &&
    source.provider_id === selectedDevice.providerId &&
    source.local_id === selectedDevice.localId, '真实会话来源与选中设备不符');
  return { id: ownedSession, request: session.request, source: session.source };
}

export async function enableFrames() {
  await toggle('performance-live-frames', true);
}

function chartPoints(value: unknown): readonly (number | null)[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) => {
    const point: unknown = isRecord(item) ? item['value'] : item;
    const y: unknown = Array.isArray(point) ? point[1] : point;
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
  });
}
function chartObservation(label: string) {
  const host = document.querySelector(`[aria-label="${label}"]`);
  if (!(host instanceof HTMLElement)) return null;
  const chart = getInstanceByDom(host);
  const canvas = host.querySelector('canvas');
  if (!chart || !(canvas instanceof HTMLCanvasElement)) return null;
  const box = canvas.getBoundingClientRect();
  const option: unknown = chart.getOption();
  check(isRecord(option), 'ECharts 实际选项不是对象');
  const series: unknown = option['series'];
  const axes: unknown = option['yAxis'];
  return {
    label, width: box.width, height: box.height, canvasWidth: canvas.width, canvasHeight: canvas.height,
    series: Array.isArray(series) ? series.filter(isRecord).map((item) => ({
      id: typeof item['id'] === 'string' ? item['id'] : '', data: chartPoints(item['data']),
    })) : [],
    axes: Array.isArray(axes) ? axes.filter(isRecord).map((axis) => ({
      min: typeof axis['min'] === 'number' ? axis['min'] : null,
      max: typeof axis['max'] === 'number' ? axis['max'] : null,
    })) : [],
  };
}

export async function observe() {
  const current = requireServices();
  const snapshot = current.runtime.performance.snapshot();
  const framed: { sequence: number; capturedAt: number; deltaMs: number; title: string; width: number; height: number }[] = [];
  const imageFailures: string[] = [];
  for (const image of document.querySelectorAll('[aria-label="采样画面"] img')) {
    if (!(image instanceof HTMLImageElement)) continue;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([image.decode(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('设备画面解码超过 1500 毫秒')), 1500);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      check(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0, '设备画面未成功解码');
      const owner = image.closest('button');
      const title = owner?.title ?? '';
      const index = Number(owner?.getAttribute('aria-label')?.match(/^采样画面 (\d+)/)?.[1]) - 1;
      const reading = snapshot.readings[index];
      const delta = Number(title.match(/偏差 (\d+) ms/)?.[1]);
      check(reading && Number.isFinite(delta) && delta <= 5000 && title.includes('非精确单帧'),
        '画面未关联到实际样本或缺少近邻偏差标记');
      const box = image.getBoundingClientRect();
      check(box.width > 0 && box.height > 0, '设备画面显示区域为零');
      framed.push({ sequence: reading.sequence, capturedAt: reading.captured_at, deltaMs: delta,
        title, width: image.naturalWidth, height: image.naturalHeight });
    } catch (error) {
      imageFailures.push(error instanceof Error ? error.message : '画面解码失败');
    }
  }
  const charts = ['帧率曲线', '性能数据三轨曲线'].map(chartObservation);
  const readings = snapshot.readings.map((reading) => ({
    sequence: reading.sequence, capturedAt: reading.captured_at, fps: reading.fps ?? null,
    cpu: reading.cpu_share_percent ?? null, pssKib: reading.pss_kib ?? null, rssKib: reading.rss_kib ?? null,
  }));
  return {
    at: new Date().toISOString(), session: snapshot.session, readings, count: readings.length,
    pending: snapshot.pending, nextAfter: snapshot.nextAfter, needsReconcile: snapshot.needsReconcile,
    error: snapshot.error instanceof Error ? snapshot.error.message : snapshot.error === null ? null : '性能模型存在非标准错误',
    charts, frames: framed, imageFailures, blocked: [...blocked], errors: [...errors],
    dom: document.querySelector('[data-product-page="performance"]')?.textContent ?? '',
    viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth },
    requests: [...requests],
  };
}

export async function control(action: 'pause' | 'resume' | 'stop') {
  const current = requireServices();
  check(ownedSession && current.runtime.performance.snapshot().selection === ownedSession, '只能控制本轮创建的会话');
  const labels = { pause: '暂停', resume: '继续', stop: '终止' };
  const states = { pause: 'paused', resume: 'running', stop: 'stopped' };
  button(labels[action]).click();
  await until(() => {
    const snapshot = current.runtime.performance.snapshot();
    return snapshot.session?.state === states[action] && !snapshot.pending;
  }, `DOM ${labels[action]}`);
  return observe();
}

export async function readState() {
  const current = requireServices();
  let after = requests.length;
  button('重查状态').click();
  await wait(0);
  await until(() => !current.runtime.performance.snapshot().pending && requests.slice(after).some((request) =>
    request.action === 'android.performance.inspect' && request.status !== null && request.status < 300), '重查会话状态');
  check(current.runtime.performance.snapshot().error === null, '重查状态未被模型成功消费');
  after = requests.length;
  button('追加样本').click();
  await wait(0);
  await until(() => !current.runtime.performance.snapshot().pending && requests.slice(after).some((request) =>
    request.action === 'android.performance.samples' && request.status !== null && request.status < 300), '读取实际样本页');
  check(current.runtime.performance.snapshot().error === null, '样本页未被模型成功消费');
  return observe();
}

export async function readTerminal() {
  const snapshot = requireServices().runtime.performance.snapshot();
  check(snapshot.session?.id === ownedSession && snapshot.session.state === 'stopped', '尚未消费本轮停止终态');
  return readState();
}

function pageError(event: ErrorEvent) { errors.push(event.message); }
function rejection(event: PromiseRejectionEvent) {
  errors.push(event.reason instanceof Error ? event.reason.message : '未处理的页面异步错误');
}
window.addEventListener('error', pageError);
window.addEventListener('unhandledrejection', rejection);

export async function dispose() {
  closing = true;
  const current = services;
  const cleanup: { stopped: boolean; disposed: boolean; errors: string[] } = { stopped: false, disposed: false, errors: [] };
  try {
    const frames = document.getElementById('performance-live-frames');
    if (frames && checked(frames) && !frames.hasAttribute('disabled') && frames.getAttribute('aria-disabled') !== 'true') {
      try { await toggle('performance-live-frames', false); }
      catch (error) { cleanup.errors.push(error instanceof Error ? error.message : '关闭画面开关失败'); }
    }
    if (current && startJob && !ownedSession) {
      // 开始操作可能已在服务器成功、但页面还没选择；查回本轮作业，不能把关页当成停止采集。
      let result = await current.runtime.tasks.get(startJob, AbortSignal.timeout(3000));
      if (['queued', 'running'].includes(result.data.status))
        result = await current.runtime.tasks.cancel(startJob, AbortSignal.timeout(3000));
      if (result.data.status === 'succeeded') {
        const value: unknown = result.data.result;
        if (isRecord(value) && typeof value['id'] === 'string' && value['state'] === 'running') {
          ownedSession = value['id'];
          const stopped = await current.runtime.performance.stop(ownedSession, AbortSignal.timeout(3000));
          check(stopped.data.state === 'stopped', '未消费到异常开始会话的停止终态');
        } else cleanup.errors.push('开始作业成功但会话归属尚未核对，不能确认采集回收');
      } else if (!['cancelled', 'failed'].includes(result.data.status))
        cleanup.errors.push('开始作业取消未确认，不能确认采集回收');
    }
    if (startAttempted && !startJob && !ownedSession)
      cleanup.errors.push('开始请求没有返回作业归属，不能确认服务器采集是否已创建');
    const session = current?.runtime.performance.snapshot().session;
    if (session && ownedSession === session.id && ['running', 'paused'].includes(session.state)) {
      // 异常收尾优先走页面；只有 DOM 已损坏才用私有实例停止本轮会话，不启动或重启游戏。
      try { await control('stop'); }
      catch {
        await current?.runtime.performance.stop(session.id, AbortSignal.timeout(5000));
      }
    }
    cleanup.stopped = (!session && cleanup.errors.length === 0) || current?.runtime.performance.snapshot().session?.state === 'stopped' ||
      current?.runtime.performance.snapshot().session?.state === 'completed';
  } catch (error) {
    cleanup.errors.push(error instanceof Error ? error.message : '停止采集失败');
  } finally {
    try { root?.unmount(); }
    catch (error) { cleanup.errors.push(error instanceof Error ? error.message : '页面卸载失败'); }
    root = null;
    window.removeEventListener('error', pageError);
    window.removeEventListener('unhandledrejection', rejection);
    try {
      await current?.dispose();
      cleanup.disposed = true;
    } catch (error) {
      cleanup.errors.push(error instanceof Error ? error.message : '产品实例释放失败');
    }
    services = null;
    container?.remove();
    container = null;
  }
  return cleanup;
}

export interface PerformanceAcceptanceHarness {
  mount: typeof mount;
  begin: typeof begin;
  enableFrames: typeof enableFrames;
  observe: typeof observe;
  control: typeof control;
  readState: typeof readState;
  readTerminal: typeof readTerminal;
  dispose: typeof dispose;
}
