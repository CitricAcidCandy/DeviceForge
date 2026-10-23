import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { powershellArguments, prepareHost, reservePort } from './terminal-pty-smoke/host.mjs';
import { input, open, output } from './terminal-pty-smoke/cases.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';

// 独占宿主内验证shell派生原生程序的标准句柄；不改变生产环境白名单。
const root = fileURLToPath(new URL('../', import.meta.url));
const [sourceHost, sourcePlugin] = process.argv.slice(2);
assert.ok(sourceHost && sourcePlugin);
const directory = resolve(join(root, 'artifacts/terminal-pty-20261022', 'native-child-' + randomUUID()));
const snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = { started_at: new Date().toISOString(), directory, passed: false, requests: [] };
let host;
try {
  report.inputs = await Promise.all([sourceHost, sourcePlugin].map(fileIdentity));
  await copyFile(sourceHost, join(snapshot, 'apk-server.exe'));
  await copyFile(sourcePlugin, join(snapshot, 'deviceforge-terminal-plugin.exe'));
  const fixture = join(snapshot, 'native-child.cjs'), observed = join(directory, 'native-child.json');
  await writeFile(fixture, `const fs=require('fs');const result={pid:process.pid,stdin_tty:!!process.stdin.isTTY,stdout_tty:!!process.stdout.isTTY,stderr_tty:!!process.stderr.isTTY};for(const fd of [0,1,2]){try{const stat=fs.fstatSync(fd);result['fd_'+fd]={character:stat.isCharacterDevice(),fifo:stat.isFIFO(),file:stat.isFile()};}catch(error){result['fd_'+fd]={code:error.code};}}for(const fd of [1,2]){try{result['write_'+fd]=fs.writeSync(fd,'DFNATIVE:CHILD:'+fd+'\\r\\n');}catch(error){result['write_'+fd]={code:error.code,errno:error.errno};}}fs.writeFileSync(process.argv[2],JSON.stringify(result));`);
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready();
  const profiles = { powershell: { executable: 'powershell.exe', args: powershellArguments(directory), resource_scope: 'direct_process' } };
  const plugin = join(host.plugins, 'terminal'); await mkdir(plugin);
  const config = join(plugin, 'terminal.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, profiles }));
  const manifest = JSON.parse(await readFile(join(root, 'backend/plugins/terminal/manifest.json'), 'utf8'));
  manifest.executable = join(snapshot, 'deviceforge-terminal-plugin.exe'); manifest.args = ['--config', config]; manifest.configuration.defaults = { format_version: 1, profiles };
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify(manifest));
  await host.client.post('/api/v2/plugins/terminal/load');
  const session = await open(host, 'powershell'), stream = output(host, session.id);
  report.session_id = session.id;
  await stream.until(text => /PS [^\r\n]*>/.test(text), '独占PowerShell提示符');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await input(host, session.id, `& ${quote('C:/Program Files/nodejs/node.exe')} ${quote(fixture)} ${quote(observed)}; [Console]::WriteLine(('DF'+'NATIVE:EXIT:')+$LASTEXITCODE)\r`);
  const ending = await stream.until(text => text.includes('DFNATIVE:EXIT:'), '原生子进程退出码');
  report.terminal_tail = ending.text.slice(-6000);
  try { report.child = JSON.parse(await readFile(observed, 'utf8')); }
  catch (error) { report.child_observation_failure = error.code; }
  await input(host, session.id, 'exit\r');
  await stream.until((text, page) => page.session.status === 'finished', '独占诊断终端退出');
  report.session_final = await host.client.json(`/api/v2/sessions/${session.id}`);
  report.passed = report.child?.stdin_tty === true && report.child?.stdout_tty === true && report.child?.stderr_tty === true && ending.text.includes('DFNATIVE:CHILD:1') && ending.text.includes('DFNATIVE:CHILD:2');
} catch (error) { report.failure = { name: error.name, message: error.message }; }
finally {
  if (host) await host.finish().catch(error => { report.cleanup_failure = error.message; report.passed = false; });
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, child: report.child, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
