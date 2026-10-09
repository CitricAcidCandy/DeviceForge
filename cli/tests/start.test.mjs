import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { start } from '../src/start.mjs';

async function reserve() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  return { server, port:server.address().port, close:() => new Promise((resolve) => server.close(resolve)) };
}
test('真实后端通过独立前端/API 与 MCP 端口共享任务，取消关闭所有监听', async () => {
  const directory = await mkdtemp(join(tmpdir(),'deviceforge-start-'));
  const web = await reserve(); const mcp = await reserve(); await web.close(); await mcp.close();
  const controller = new AbortController(); const token = randomBytes(32).toString('hex');
  let notify; const ready = new Promise((resolve) => { notify = resolve; });
  const running = start({ip:'127.0.0.1',port:web.port,mcpPort:mcp.port,dataDirectory:directory}, {signal:controller.signal,environment:{...process.env,APK_API_TOKEN:token},onReady:notify});
  // 同时观察启动错误，失败测试不等待未触发的 onReady。
  try {
    await Promise.race([ready,running]);
    const base = `http://127.0.0.1:${web.port}`; const headers = {authorization:`Bearer ${token}`};
    const page = await fetch(base); assert.equal(page.status,200); assert.match(await page.text(),/DeviceForge/);
    assert.equal((await fetch(`${base}/api/v1/health`)).status,401);
    assert.equal((await fetch(`${base}/api/v1/health`,{headers})).status,200);
    const reply = await fetch(`http://127.0.0.1:${mcp.port}/mcp`,{method:'POST',headers:{...headers,origin:base,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
    assert.equal(reply.status,200); assert.ok((await reply.json()).result.tools.some((tool) => tool.name === 'deviceforge.get_job'));
    assert.equal((await fetch(`http://127.0.0.1:${mcp.port}/api/v1/health`,{headers})).status,404);
    // fetch 可能自行重写 Host，使用原生请求确认真实错误 Host 到达服务。
    const wrongHost = await new Promise((resolve,reject) => {
      const outgoing = request(base,{headers:{host:`unrelated.example:${web.port}`}},(response) => { response.resume(); resolve(response.statusCode); });
      outgoing.on('error',reject); outgoing.end();
    });
    assert.equal(wrongHost,403);
    controller.abort(); await running;
    const logs = (await readdir(join(directory,'logs'))).filter((name) => name.endsWith('.jsonl'));
    const text = (await Promise.all(logs.map((name) => readFile(join(directory,'logs',name),'utf8')))).join('');
    assert.ok(!text.includes(token));
    assert.ok(text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).some((record) => record.fields?.message === '宿主运行已结束'));
    await assert.rejects(fetch(`${base}/api/v1/health`,{headers,signal:AbortSignal.timeout(1000)}));
    const probe = createServer(); await new Promise((resolve,reject) => { probe.once('error',reject); probe.listen(mcp.port,'127.0.0.1',resolve); });
    await new Promise((resolve) => probe.close(resolve));
  } finally { controller.abort(); await running.catch(() => {}); await rm(directory,{recursive:true,force:true}); }
});
test('第二端口占用时清理第一监听，局域网缺少令牌在启动前拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(),'deviceforge-start-fail-'));
  const web = await reserve(); const mcp = await reserve(); await web.close();
  try {
    await assert.rejects(start({ip:'0.0.0.0',port:web.port,mcpPort:mcp.port,dataDirectory:directory},{environment:{}}),/APK_API_TOKEN/);
    await assert.rejects(start({ip:'127.0.0.1',port:web.port,mcpPort:mcp.port,dataDirectory:directory},{environment:{}}),/EADDRINUSE/);
    const probe = createServer(); await new Promise((resolve,reject) => { probe.once('error',reject); probe.listen(web.port,'127.0.0.1',resolve); });
    await new Promise((resolve) => probe.close(resolve));
  } finally { await mcp.close(); await rm(directory,{recursive:true,force:true}); }
});
