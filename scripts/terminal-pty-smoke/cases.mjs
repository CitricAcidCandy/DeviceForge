import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPidGone, poll } from '../terminal-interactive-smoke/cases.mjs';
import { newConsoleWindows, windowsObservation } from './windows.mjs';

export const terminal = (cols = 120, rows = 30) => ({
  protocol: 'deviceforge.terminal.v1', cols, rows,
});
export async function open(host, profile, options = terminal()) {
  return host.client.post('/api/v2/sessions', {
    operation: 'plugin.terminal.open', input: { profile, terminal: options },
  }, { status: 202 });
}
export async function message(host, id, value) {
  return host.client.post(`/api/v2/sessions/${id}/input`, {
    bytes: [...Buffer.from(JSON.stringify(value), 'utf8')],
  });
}
export const input = (host, id, text) => message(host, id, { type: 'input', text });

export function output(host, id) {
  let cursor = 0;
  let cursorQueries = 0;
  const chunks = [];
  return {
    async read() {
      const page = await host.client.json(`/api/v2/sessions/${id}/output?after=${cursor}&limit=100`);
      for (const chunk of page.chunks) {
        assert.equal(chunk.sequence, ++cursor, 'PTY输出序号必须连续');
        assert.equal(chunk.stream, 'stdout', 'PTY合并双路到stdout');
        chunks.push(Buffer.from(chunk.bytes));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      // 无浏览器的HTTP探针负责回答ConPTY光标查询，浏览器由xterm处理。
      const requested = [...raw.matchAll(/\u001b\[6n/g)].length;
      while (cursorQueries < requested) {
        cursorQueries++;
        await input(host, id, '\u001b[1;1R');
      }
      return { text: stripVTControlCharacters(raw), page };
    },
    async until(accept, label, budget = 15000) {
      return poll(() => this.read(), (value) => accept(value.text, value.page), label, budget);
    },
    bytes: () => Buffer.concat(chunks),
  };
}

function marker(text, kind) {
  const match = text.match(new RegExp(`DFPTY:${kind}:(\\{[^{}]*\\})`));
  return match ? JSON.parse(match[1]) : undefined;
}
function inputMarkers(text) {
  return [...text.matchAll(/DFPTY:INPUT:(\{[^{}]*\})/g)].map((match) => JSON.parse(match[1]));
}
async function finished(host, id, cancelled = false) {
  const current = await poll(
    () => host.client.json(`/api/v2/sessions/${id}`),
    (value) => value.status === 'finished', 'PTY会话终态', 20000,
  );
  assert.equal(current.completion.cleanup, 'complete', '整个终端作用域须已清理');
  assert.equal(current.completion.process_exited, true);
  if (cancelled) assert.equal(current.completion.failure?.code, 'cancelled');
  else assert.equal(current.completion.failure, null);
  return current;
}

export async function ttyCase(host, report) {
  const before = await windowsObservation(host.child.pid);
  const session = await open(host, 'probe');
  const stream = output(host, session.id);
  const ready = await stream.until((text) => marker(text, 'READY'), '真实TTY就绪');
  const observed = marker(ready.text, 'READY');
  assert.equal(observed.stdin_tty, true);
  assert.equal(observed.stdout_tty, true);
  assert.equal(observed.cols, 120);
  assert.equal(observed.rows, 30);
  const after = await windowsObservation(host.child.pid);
  assert.deepEqual(newConsoleWindows(before, after), [], 'PTY不得创建可见原生控制台');
  const bytes = Buffer.from('中文🙂\t\u001b[A\u0003', 'utf8');
  await input(host, session.id, bytes.toString());
  await stream.until((text) => inputMarkers(text).some((entry) => entry.total_hex === bytes.toString('hex')), '精确原始按键与中文');
  await stream.until((text) => marker(text, 'INTERRUPT')?.alive, 'Ctrl+C进入同一个TTY');
  assert.ok(stream.bytes().includes(Buffer.from('\u001b[31m')), 'ANSI颜色原字节不得丢失');
  await message(host, session.id, { type: 'resize', cols: 91, rows: 24 });
  const resized = await stream.until((text) => marker(text, 'RESIZE')?.cols === 91, 'ConPTY真实尺寸更新');
  assert.equal(marker(resized.text, 'RESIZE').rows, 24);
  await input(host, session.id, '\u0004');
  const current = await finished(host, session.id);
  assert.equal(current.completion.outcome.error, null);
  await assertPidGone(observed.pid);
  report.sessions.push({ id: session.id, entry: '原生TTY', pid: observed.pid, pid_absent: true, cleanup: 'complete' });
  report.observations.push({ name: '原生TTY与可见窗口', before, after });
  report.checks.push({ name: '真实TTY、UTF8/ANSI、Tab/方向/Ctrl+C、resize与自然退出', passed: true });
}

export async function powershellCase(host, report) {
  const session = await open(host, 'powershell');
  const stream = output(host, session.id);
  await stream.until((text) => /PS [^\r\n]*>/.test(text), 'PowerShell交互提示符');
  await input(host, session.id, "[Console]::WriteLine(('DF'+'PS:READY:')+[Console]::IsInputRedirected+':'+[Console]::IsOutputRedirected)\r");
  await stream.until((text) => text.includes('DFPS:READY:False:False'), '真实PowerShell控制台身份');
  await input(host, session.id, "$dfprobe='终端中文🙂'; [Console]::WriteLine(('DF'+'PS:TEXT:')+$dfprobe)\r");
  try { await stream.until((text) => text.includes('DFPS:TEXT:终端中文'), 'PowerShell中文输入输出'); }
  catch (error) {
    report.powershell_failure = { session_id: session.id, bytes_hex: stream.bytes().toString('hex'), text: stream.bytes().toString('utf8') };
    throw error;
  }
  if (!stream.bytes().toString('utf8').includes('DFPS:TEXT:终端中文🙂')) {
    (report.limitations ??= []).push('Node原始TTY完整收到emoji；Windows PowerShell5命令编辑器在本次输入中丢弃emoji，PowerShell仅确认中文。');
  }
  await message(host, session.id, { type: 'resize', cols: 100, rows: 28 });
  await input(host, session.id, "[Console]::WriteLine(('DF'+'PS:SIZE:')+[Console]::WindowWidth+':'+[Console]::WindowHeight)\r");
  await stream.until((text) => text.includes('DFPS:SIZE:100:28'), 'PowerShell感知尺寸');
  try {
    await input(host, session.id, 'Start-Sleep -Seconds 60\r');
    await delay(350);
    await stream.read(); const beforeInterrupt = stream.bytes().length;
    await input(host, session.id, '\u0003');
    await stream.until(() => /PS [^\r\n]*>/.test(stripVTControlCharacters(stream.bytes().subarray(beforeInterrupt).toString('utf8'))), 'Ctrl+C后等待shell重新就绪');
    await input(host, session.id, "[Console]::WriteLine('DF'+'PS:AFTER-CTRL-C')\r");
    await stream.until((text) => text.includes('DFPS:AFTER-CTRL-C'), 'Ctrl+C打断命令后同shell继续');
  } catch (error) {
    report.powershell_failure = { session_id: session.id, bytes_hex: stream.bytes().toString('hex'), text: stream.bytes().toString('utf8') };
    throw error;
  }
  await input(host, session.id, 'exit\r');
  const current = await finished(host, session.id);
  assert.equal(current.completion.outcome.error, null);
  report.sessions.push({ id: session.id, entry: '真实PowerShell', cleanup: 'complete' });
  report.checks.push({ name: '真实PowerShell提示符、中文、尺寸、Ctrl+C及exit', passed: true });
}

export async function pipeCase(host, report) {
  const session = await host.client.post('/api/v2/sessions', {
    operation: 'plugin.terminal.open', input: { profile: 'probe' },
  }, { status: 202 });
  const stream = output(host, session.id);
  const ready = await stream.until((text) => marker(text, 'READY'), '旧管道夹具就绪');
  const observed = marker(ready.text, 'READY');
  assert.equal(observed.stdin_tty, false);
  assert.equal(observed.stdout_tty, false);
  const bytes = [65, 0, 255, 10];
  await host.client.post(`/api/v2/sessions/${session.id}/input`, { bytes });
  await stream.until((text) => inputMarkers(text).some((entry) => entry.total_hex === Buffer.from(bytes).toString('hex')), '旧管道原字节兼容');
  await host.client.post(`/api/v2/sessions/${session.id}/eof`);
  const current = await finished(host, session.id);
  assert.equal(current.completion.outcome.error, null);
  await assertPidGone(observed.pid);
  report.sessions.push({ id: session.id, entry: '旧管道原字节兼容', pid: observed.pid, cleanup: 'complete' });
  report.checks.push({ name: '未声明terminal的旧请求保持管道原字节与EOF语义', passed: true });
}

export async function treeCase(host, report, identityFile, action = 'cancel') {
  const identities = [identityFile, identityFile + '.child', identityFile + '.child.grandchild'];
  for (const path of identities) {
    try { await unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const session = await open(host, 'branch');
  const entries = await Promise.all(identities.map((path) => poll(async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, Boolean, '派生树身份文件')));
  const baseline = report.initial_windows;
  const live = await windowsObservation(host.child.pid);
  assert.deepEqual(newConsoleWindows(baseline, live), [], '孙进程不得另开可见终端窗口');
  for (const entry of entries) assert.ok(live.processes.some((value) => value.pid === entry.pid));
  if (action === 'unload') await host.client.post('/api/v2/plugins/terminal/unload');
  else if (action === 'shutdown') await host.shutdown();
  else await host.client.post(`/api/v2/sessions/${session.id}/${action}`);
  const current = action === 'shutdown' ? null : await finished(host, session.id, action === 'cancel' || action === 'unload');
  await Promise.all(entries.map((entry) => assertPidGone(entry.pid)));
  report.sessions.push({ id: session.id, entry: `三层派生树-${action}`, pids: entries.map((entry) => entry.pid), all_pids_absent: true, cleanup: current?.completion.cleanup });
  report.observations.push({ name: `三层派生树-${action}`, live });
  report.checks.push({ name: `${action}后确认三层派生树全部退出`, passed: true });
}

export async function malformedCase(host, report) {
  const session = await open(host, 'probe');
  const stream = output(host, session.id);
  await stream.until((text) => marker(text, 'READY'), '非法消息夹具就绪');
  await message(host, session.id, { type: 'resize', cols: 1, rows: 30 });
  const current = await finished(host, session.id);
  assert.equal(typeof current.completion.outcome.error, 'string');
  const ending = await stream.read();
  assert.equal(marker(ending.text, 'INPUT'), undefined, '控制消息不得泄漏到shell输入');
  report.sessions.push({ id: session.id, entry: '非法缩放消息', cleanup: 'complete' });
  report.checks.push({ name: '非法消息终止并清理，不能作为shell输入', passed: true });
}
