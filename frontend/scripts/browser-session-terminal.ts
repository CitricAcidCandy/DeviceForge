import { TerminalPage } from '../src/app/product/pages/terminal.tsx';
import { McpConnection } from '../src/app/product/mcp-connection.tsx';
import { button, check, click, fill, pause, until } from './session-browser-actions.ts';
import { fixtureObject } from './session-fixture-streams.ts';
import type { SessionBrowserContext } from './session-browser-context.ts';

export async function verifyTerminalAndMcp({target, services, fixture, mount, passed}: SessionBrowserContext) {
  const cancels = () => fixture.requests.filter(request => request.method === 'POST' && request.path.endsWith('/cancel')).length;
  const opens = () => fixture.requests.filter(request => request.method === 'POST' && request.path === '/api/v2/sessions').length;
  await mount(TerminalPage); check(button('打开终端').disabled, '未读取会话目录仍能打开终端');
  await click('刷新会话目录'); await until(() => !button('打开终端').disabled, '终端目录未开放正确操作'); passed('终端依照独立会话目录准入');
  await click('打开终端'); await until(() => services.sessions.snapshot().session !== null && !button('发送').disabled, '终端未建立可写会话');
  const id = services.sessions.snapshot().session?.id; check(id, '终端没有公开会话 ID');
  await click('持续读取'); await until(() => target.querySelector('[aria-label="终端输出"]')?.textContent?.includes('终端中文🙂') ?? false, '终端跨片 UTF-8 没有正确呈现');
  check(!target.querySelector('[aria-label="终端输出"]')?.textContent?.includes('�'), '终端跨片解码出现替换字符'); passed('终端跨字节中文与表情连续解码');
  const beforeCancel = cancels(); await until(() => fixture.streams.pending() > 0, '终端轮询未进入受控等待');
  await click('暂停读取'); await until(() => !button('持续读取').disabled, '暂停读取未结束页面等待');
  check(cancels() === beforeCancel && fixture.streams.aborted() > 0, '暂停读取错误停止了服务器会话'); passed('终端暂停撤销读取且不发送停止请求');
  await fill('终端输入', 'echo 中文🙂'); await click('发送'); await until(() => String(fieldValue()) === '', '发送成功未清空终端输入');
  const sent = fixture.requests.filter(request => request.path.endsWith('/input')).at(-1)?.input;
  check(fixtureObject(sent) && Array.isArray(sent['bytes']) && new TextDecoder().decode(Uint8Array.from(sent['bytes'])) === 'echo 中文🙂\n', '终端发送未保留 UTF-8 与换行'); passed('终端发送精确 UTF-8 字节');
  await click('关闭输入'); await until(() => button('发送').disabled, 'EOF 后输入入口仍开放');
  check(fixture.requests.some(request => request.path === `/api/v2/sessions/${id}/eof`), 'EOF 未走公开端点'); passed('终端 EOF回执后禁止继续输入');
  const beforeOpen = opens(); await fill('恢复会话 ID', id); await click('恢复');
  await until(() => services.sessions.snapshot().session?.id === id && services.sessions.snapshot().inputState === 'unknown', '终端恢复未保留输入状态不确定性');
  check(opens() === beforeOpen && button('发送').disabled, '恢复终端重复Open或冒充输入可写'); passed('终端恢复使用已知ID且保留输入状态不确定性');
  await click('停止会话'); await until(() => services.sessions.snapshot().session?.status === 'stopping', '终端停止未呈现 stopping');
  check(button('删除已结束记录').disabled, 'stopping 冒充已结束');
  await click('重查状态'); await until(() => services.sessions.snapshot().session?.status === 'finished', '终端停止后未重新观察 finished');
  check(cancels() === beforeCancel + 1, '停止会话没有且仅有一次 cancel'); passed('终端停止与重新查询结束证据分开');
  await click('删除已结束记录'); await until(() => services.sessions.snapshot().session === null, '终端结束记录没有移除'); passed('终端仅结束后删除记录');
  await mount(McpConnection); await click('读取 MCP 工具目录');
  await until(() => target.textContent?.includes('fixture.tool.1') ?? false, 'MCP 工具目录未呈现专用表格');
  check(target.querySelectorAll('tbody tr').length === 1, 'MCP 用 HTTP 操作数代替工具数'); passed('MCP独立JSON-RPC工具目录');
  await click('订阅目录变化'); await until(() => target.textContent?.includes('已订阅目录变化') ?? false, 'MCP订阅未等待协议确认');
  fixture.notifyMcp(); await until(() => target.textContent?.includes('fixture.tool.2') ?? false, '目录失效通知没有刷新工具表'); passed('MCP确认订阅后动态更新目录');
  await click('停止订阅'); await until(() => fixture.subscriptionCancelled() > 0, 'MCP停止订阅没有释放流读取器'); await pause(); passed('MCP停止订阅释放流资源');
  function fieldValue() {return target.querySelector<HTMLInputElement>('input[placeholder="输入命令后发送"]')?.value;}
}
