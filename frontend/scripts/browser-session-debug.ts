import { FridaPage } from '../src/pages/frida/index.tsx';
import { AutomationPage } from '../src/pages/automation/index.tsx';
import {
  button,
  check,
  click,
  field,
  fill,
  pause,
  select,
  until,
  upload,
} from './session-browser-actions.ts';
import { fixtureObject } from './session-fixture-streams.ts';
import type { SessionBrowserContext } from './session-browser-context.ts';

export async function verifyFridaAndAutomation({
  target,
  services,
  fixture,
  mount,
  passed,
}: SessionBrowserContext) {
  const signal = () => new AbortController().signal;
  const submitted = () =>
    fixture.requests.filter(
      (request) => request.path === '/api/v2/jobs' && request.method === 'POST',
    );
  const restore = async () => {
    fixture.restoreOperations();
    await services.runtime.operations.refresh(signal());
    await pause();
  };
  fixture.setOperations(['plugin.frida.server.status']);
  await services.runtime.operations.refresh(signal());
  await mount(FridaPage);
  check(
    !button('检查状态').disabled &&
      button('读取进程').disabled &&
      button('限时运行服务器').disabled,
    'Frida借状态贡献开放其它操作',
  );
  passed('Frida每项操作精确目录准入');
  await click('检查状态');
  await until(
    () => target.textContent?.includes('发现进程 321') ?? false,
    'Frida状态没有专用PID输出',
  );
  check(
    target.textContent?.includes('只读观测，不宣称由本次调用创建或持有') &&
      target.textContent?.includes('16.7.0'),
    'Frida状态遗漏观测所有权或版本',
  );
  passed('Frida状态版本与观测所有权专用展示');
  await click('读取运行日志');
  await until(
    () => target.textContent?.includes('受控 frida.log 日志🙂') ?? false,
    'Frida日志未经过产物校验读取',
  );
  await click('frida.log');
  await until(
    () => target.querySelector('a[download="frida.log"]') !== null,
    'Frida校验下载没有形成对象URL',
  );
  passed('Frida真实产物元数据与SHA校验下载');
  await restore();
  await click('读取进程');
  await until(
    () => target.querySelector('tbody')?.textContent?.includes('受控应用进程') ?? false,
    'Frida进程没有专用表格',
  );
  passed('Frida进程专用列表');
  await upload('Frida 服务器文件', 'server.bin');
  await click('上传并部署');
  await until(
    () => target.textContent?.includes('服务器部署完成') ?? false,
    'Frida部署专用回执未呈现',
  );
  passed('Frida原字节上传与部署回执');
  await click('限时运行服务器');
  await until(
    () => target.textContent?.includes('创建标识 1000') ?? false,
    'Frida受控运行没有进程创建标识',
  );
  check(target.textContent?.includes('已确认本次调用持有的进程清理'), 'Frida运行遗漏清理证据');
  passed('Frida运行回执限定进程所有权与清理范围');
  await fill('应用包名', 'com.fixture.demo');
  await upload('UTF-8 脚本', 'script.js');
  await click('运行脚本');
  await until(
    () =>
      (target.textContent?.includes('3 条') && target.textContent?.includes('钩子执行摘要')) ||
      false,
    'Frida脚本没有通知与钩子摘要',
  );
  check(target.textContent?.includes('不宣称目标应用进程已退出'), 'Frida脚本误宣称目标进程退出');
  passed('Frida脚本目标、通知、摘要和清理边界');
  await click('分析权限调用');
  await until(
    () => target.textContent?.includes('permissions.js') ?? false,
    'Frida权限分析未保留专用脚本产物',
  );
  passed('Frida权限分析使用独立操作与产物');
  fixture.setOperations([
    'plugin.automation.sequence.run',
    'plugin.automation.windows.mouse.position',
  ]);
  await services.runtime.operations.refresh(signal());
  await mount(AutomationPage);
  await click('添加步骤');
  check(
    !button('运行设备流程').disabled &&
      button('重复点击设备').disabled &&
      !button('读取服务器鼠标位置').disabled,
    '设备sequence与repeat入口混用',
  );
  for (const label of ['执行桌面点击', '执行桌面连续点击', '开始录制轨迹'])
    check(button(label).disabled, `鼠标position贡献误开放${label}`);
  passed('自动化sequence、repeat、mouse、trace逐项精确准入');
  await click('运行设备流程');
  await until(
    () => target.textContent?.includes('已派发 1 次输入') ?? false,
    '设备流程没有专用派发回执',
  );
  check(target.textContent?.includes('界面效果尚未确认'), '设备流程误宣称界面效果');
  passed('设备步骤执行与派发回执边界');
  await select('步骤类型', '滑动');
  await click('添加步骤');
  await select('步骤类型', '按键');
  await click('添加步骤');
  await select('步骤类型', '文本');
  await fill('设备输入文本', '中文');
  const beforeSteps = target.querySelectorAll('.workflow-steps li').length;
  await click('添加步骤');
  check(
    target.querySelectorAll('.workflow-steps li').length === beforeSteps &&
      target.textContent?.includes('不支持中文输入'),
    '旧ASCII文本合同被界面放宽',
  );
  await fill('设备输入文本', 'ascii_demo');
  await click('添加步骤');
  check(
    target.querySelector('.workflow-steps')?.textContent?.includes('滑动到') &&
      target.querySelector('.workflow-steps')?.textContent?.includes('派发按键码 4') &&
      target.querySelector('.workflow-steps')?.textContent?.includes('ascii_demo'),
    '自动化步骤仍只有原始JSON',
  );
  await click('运行设备流程');
  await until(
    () => target.textContent?.includes('已派发 4 次输入') ?? false,
    '四类步骤没有正确运行',
  );
  await click('移除步骤 4');
  check(target.querySelectorAll('.workflow-steps li').length === 3, '步骤移除没有更新列表');
  passed('点击滑动按键文本可读编辑与ASCII限制');
  await click('读取服务器鼠标位置');
  await until(() => target.textContent?.includes('(-1920, 120)') ?? false, '虚拟桌面负坐标未呈现');
  passed('桌面鼠标位置保留虚拟桌面负坐标');
  await restore();
  const beforeDialog = submitted().length;
  await click('执行桌面点击');
  check(
    document.querySelector('[role="dialog"]')?.textContent?.includes('执行时鼠标当前位置'),
    '桌面点击没有具体范围确认',
  );
  check(submitted().length === beforeDialog, '打开桌面确认框已经POST');
  await click('返回修改');
  check(submitted().length === beforeDialog, '关闭桌面确认框仍派发');
  passed('桌面确认框打开与取消均0POST');
  await click('执行桌面点击');
  await click('确认执行');
  await until(
    () => target.textContent?.includes('1 次 · 左键 · 单击') ?? false,
    '桌面受控点击没有专用回执',
  );
  check(
    submitted().length === beforeDialog + 1 &&
      target.textContent?.includes('已派发次数不等于界面接受次数'),
    '桌面确认后次数或效果声明错误',
  );
  passed('桌面确认后仅受控派发并展示实际回执');
  for (const [label, expected] of [
    ['按次数停止', 'count'],
    ['按时长停止', 'duration'],
    ['F9 或时限停止', 'manual'],
  ] as const) {
    await select('桌面停止条件', label);
    await click('执行桌面连续点击');
    await click('确认执行');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '桌面重复点击等待未结束');
    const request = submitted().at(-1)?.input;
    check(
      fixtureObject(request) &&
        request['operation'] === 'plugin.automation.windows.mouse.repeat' &&
        fixtureObject(request['input']) &&
        fixtureObject(request['input']['repeat']) &&
        request['input']['repeat']['kind'] === expected &&
        request['input']['stop_on_f9'] === true,
      '桌面repeat停止合同未完整提交',
    );
  }
  passed('桌面repeat次数、时长、手动时限和F9完整合同');
  await select('轨迹事件类型', '键盘输入');
  const beforeTraceDialog = submitted().length;
  await click('开始录制轨迹');
  check(submitted().length === beforeTraceDialog, '打开录制确认已经派发');
  await click('确认执行');
  await until(
    () => field('回放轨迹产物 ID').value === fixture.recordingId,
    '轨迹公开产物ID未从真实回执回填',
  );
  const recording = submitted().at(-1)?.input;
  check(
    fixtureObject(recording) &&
      fixtureObject(recording['input']) &&
      recording['input']['event_type'] === 1,
    '键盘事件类型未按协议提交1',
  );
  await click('下载 recording.msgpack');
  await until(
    () => target.querySelector('a[download="recording.msgpack"]') !== null,
    '轨迹产物校验下载未形成链接',
  );
  passed('轨迹事件类型、公开产物ID与校验下载');
  await click('回放输入轨迹');
  check(submitted().at(-1)?.input === recording, '打开回放确认已经提交');
  await click('确认执行');
  await until(
    () => target.textContent?.includes('回放回执') ?? false,
    '轨迹回放未展示专用事件数量与格式',
  );
  passed('轨迹回放仅确认后提交并展示专用回执');
}
