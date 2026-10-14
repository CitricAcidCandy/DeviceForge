import { AiPage } from '../src/pages/ai/index.tsx';
import {
  button,
  check,
  click,
  field,
  fill,
  pause,
  select,
  until,
} from './session-browser-actions.ts';
import { cliThread, fixtureObject, sdkThread } from './session-fixture-streams.ts';
import type { SessionBrowserContext } from './session-browser-context.ts';

export async function verifyAiProviders({
  target,
  services,
  fixture,
  mount,
  passed,
}: SessionBrowserContext) {
  await mount(AiPage);
  const opens = () =>
    fixture.requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/v2/sessions',
    ).length;
  const cancels = () =>
    fixture.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/cancel'),
    ).length;
  const jobs = () =>
    fixture.requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/v2/jobs',
    );
  for (const provider of ['sdk', 'cli'] as const) {
    const sdk = provider === 'sdk';
    const label = sdk ? 'SDK' : 'CLI';
    const prefix = sdk ? 'plugin.ai-sdk.' : 'plugin.ai-assistant.';
    const stream = sdk ? services.runtime.aiSdkStreaming : services.aiStreaming;
    const operation = prefix + provider + '.stream';
    const project = `${provider}-project`;
    if (!sdk) await select('AI 提供者', 'Codex CLI');
    check(field('发给助手').value === '', `${label}沿用了另一个提供者的草稿`);
    await fill(`${label} 项目 ID`, project);
    await fill('发给助手', `${provider} 独立草稿`);
    await click('刷新助手目录');
    await until(() => !button('发送并读取实时回答').disabled, `${label}独立会话目录未开放`);
    await click('检查运行资格');
    await until(
      () => target.textContent?.includes('运行资格就绪') ?? false,
      `${label}运行资格未显示`,
    );
    passed(`${label}独立目录与真实协议运行资格`);
    fixture.streams.hold(operation);
    const beforeCancel = cancels();
    await click('发送并读取实时回答');
    await until(
      () =>
        stream.snapshot().stream.text === `${label} 实时中文🙂` && fixture.streams.pending() > 0,
      `${label}跨片回答与过程未呈现`,
    );
    check(
      target
        .querySelector(`[aria-label="${provider} 助手回答"]`)
        ?.textContent?.includes(`${label} 实时中文🙂`),
      `${label}可见回答未使用流数据`,
    );
    await click('暂停等待');
    await until(() => !button('继续读取回答').disabled, `${label}暂停没有结束等待`);
    check(cancels() === beforeCancel, `${label}暂停错误调用取消端点`);
    passed(`${label}实时回答UTF-8与暂停不停止会话`);
    const id = stream.snapshot().session?.id;
    check(id, `${label}会话没有身份`);
    fixture.streams.complete(id);
    await click('继续读取回答');
    await until(() => stream.snapshot().result !== null, `${label}继续读取未确认完整终态`);
    check(stream.snapshot().owner?.project_id === project, `${label}回答归属项目串线`);
    passed(`${label}继续读取耗尽输出并核对终态`);
    const beforeOpen = opens();
    const disclosure = [...target.querySelectorAll('summary')].find(
      (item) => item.textContent === '恢复已有实时会话' && !item.closest('[hidden]'),
    );
    check(disclosure?.parentElement instanceof HTMLDetailsElement, `${label}恢复入口不存在`);
    disclosure.parentElement.open = true;
    await fill('实时传输会话 ID', sdk ? fixture.streams.sdkRecovery : fixture.streams.cliRecovery);
    await click('恢复会话');
    await until(
      () =>
        stream.snapshot().session?.id ===
        (sdk ? fixture.streams.sdkRecovery : fixture.streams.cliRecovery),
      `${label}未恢复指定传输会话`,
    );
    check(opens() === beforeOpen, `${label}恢复重复创建服务器会话`);
    await click('继续读取回答');
    await until(() => stream.snapshot().result !== null, `${label}恢复后无法读取终态`);
    passed(`${label}恢复沿会话ID查询且不重复Open`);
    await select('执行方式', '单次任务');
    fixture.setOperations([prefix + provider + '.single']);
    await services.runtime.operations.refresh(new AbortController().signal);
    await pause();
    check(!button('发起单次任务').disabled, `${label}精确single入口错误关闭`);
    await select('执行方式', '线程续聊任务');
    check(button('发起线程续聊').disabled, `${label}借用single贡献开放turn`);
    if (sdk) {
      await select('执行方式', '编排助手任务');
      check(button('运行编排助手').disabled, 'SDK借用single贡献开放assistant');
    }
    fixture.restoreOperations();
    await services.runtime.operations.refresh(new AbortController().signal);
    await pause();
    passed(`${label}single、turn、assistant按精确操作独立准入`);
    await select('执行方式', '单次任务');
    await click('发起单次任务');
    await until(
      () =>
        target
          .querySelector(`[aria-label="${provider} 助手回答"]`)
          ?.textContent?.includes(`${label} 单次回答`) ?? false,
      `${label}single结果没有专用回答`,
    );
    check(
      fixtureObject(jobs().at(-1)?.input) &&
        jobs().at(-1)?.input &&
        jobs().at(-1)?.path === '/api/v2/jobs',
      `${label}single未走任务协议`,
    );
    passed(`${label}single任务结果独立呈现`);
    await select('执行方式', '线程续聊任务');
    await click('发起线程续聊');
    await until(
      () =>
        target
          .querySelector(`[aria-label="${provider} 助手回答"]`)
          ?.textContent?.includes(`${label} 续聊回答`) ?? false,
      `${label}turn没有呈现续聊回答`,
    );
    const turn = jobs().at(-1)?.input;
    check(
      fixtureObject(turn) &&
        turn['operation'] === prefix + provider + '.turn' &&
        fixtureObject(turn['input']) &&
        turn['input']['thread_id'] === (sdk ? sdkThread : cliThread),
      `${label}续聊线程串线`,
    );
    passed(`${label}turn保留自己项目与线程`);
    if (sdk) {
      await select('执行方式', '编排助手任务');
      await click('运行编排助手');
      await until(
        () =>
          target
            .querySelector('[aria-label="sdk 助手回答"]')
            ?.textContent?.includes('SDK 编排回答') ?? false,
        'SDK编排助手结果未呈现',
      );
      const assistant = jobs().at(-1)?.input;
      check(
        fixtureObject(assistant) &&
          assistant['operation'] === 'plugin.ai-sdk.assistant.run' &&
          fixtureObject(assistant['input']) &&
          assistant['input']['user_prompt'] === 'sdk 独立草稿' &&
          assistant['input']['stream_output'] === false,
        'SDK编排字段与单次任务混用',
      );
      passed('SDKassistant独立协议与非流结果');
    }
    await click('查询线程');
    await until(() => target.textContent?.includes('2 轮') ?? false, `${label}线程查询未显示轮数`);
    await click('关闭线程');
    await until(
      () => target.textContent?.includes('线程已关闭') ?? false,
      `${label}线程关闭结果未显示`,
    );
    passed(`${label}线程查询和关闭回执`);
    await select('执行方式', '实时回答');
    await click('发送并读取实时回答');
    await until(
      () => stream.snapshot().session?.status === 'running' && !button('停止本次会话').disabled,
      `${label}停止验收会话未建立`,
    );
    const cancelBeforeStop = cancels();
    await click('停止本次会话');
    await until(
      () => stream.snapshot().session?.status === 'stopping',
      `${label}停止请求没有独立状态`,
    );
    check(cancels() === cancelBeforeStop + 1, `${label}显式停止不是一次独立cancel`);
    passed(`${label}显式停止与暂停使用不同请求`);
  }
  await select('AI 提供者', 'Codex SDK');
  check(
    field('SDK 项目 ID').value === 'sdk-project' &&
      field('发给助手').value === 'sdk 独立草稿' &&
      field('线程 ID（可选）').value === sdkThread,
    '切换提供者丢失SDK草稿/项目/线程',
  );
  await select('AI 提供者', 'Codex CLI');
  check(
    field('CLI 项目 ID').value === 'cli-project' &&
      field('发给助手').value === 'cli 独立草稿' &&
      field('线程 ID（可选）').value === cliThread,
    '切换提供者丢失CLI草稿/项目/线程',
  );
  passed('CLI和SDK可见切换保留相互独立草稿与线程');
}
