// 三个普通插件的隔离部署、合成 CLI 门闩和有界网络辅助。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const suffix = process.platform === 'win32' ? '.exe' : '';
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}
export async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await sleep(25); }
  throw new Error(`等待超时：${label}`);
}
export async function port(): Promise<number> {
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); return address.port;
}
export async function portReleased(selected: number): Promise<boolean> {
  const listener = createServer();
  const bound = await new Promise<boolean>((done) => {
    listener.once('error', () => done(false)); listener.listen(selected, '127.0.0.1', () => done(true));
  });
  if (bound) await new Promise<void>((done) => listener.close(() => done()));
  return bound;
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (object(error).code === 'ESRCH') return false;
    throw error;
  }
}
export async function tool(root: string, id: string, source: string) {
  const directory=join(root,'tools',id); await mkdir(directory,{recursive:true});
  const executable=join(directory,`ai-cli-fixture${suffix}`); await copyFile(source,executable);
  return {
    executable,directory,
    async reply(index:number,output:string,hold=false,code=0) {
      await writeFile(join(directory,`stdout-${index}`),output); await writeFile(join(directory,`stderr-${index}`),'');
      await writeFile(join(directory,`code-${index}`),String(code)); if (!hold) await writeFile(join(directory,`release-${index}`),'1');
    },
    async wait(index:number) {
      const end=Date.now()+10000;
      while(Date.now()<end) {try {await readFile(join(directory,`call-${String(index).padStart(2,'0')}`,'ready'));return;}catch{} await sleep(10);}
      throw new Error(`${id} 假工具未到达第 ${index} 次调用`);
    },
    async args(index:number) {
      const bytes=await readFile(join(directory,`call-${String(index).padStart(2,'0')}`,'argv.bin'));
      let offset=0; const number=()=>{assert.ok(offset+4<=bytes.length);const value=bytes.readUInt32LE(offset);offset+=4;return value;};
      const count=number();assert.ok(count<=16);const result=[];for(let i=0;i<count;i++){const size=number();assert.ok(offset+size<=bytes.length);result.push(bytes.toString('utf8',offset,offset+size));offset+=size;}assert.equal(offset,bytes.length);return result;
    },
    async input(index:number) {return Number(await readFile(join(directory,`call-${String(index).padStart(2,'0')}`,'input-bytes'),'utf8'));},
    async evidence(index:number) {
      const call=join(directory,`call-${String(index).padStart(2,'0')}`);
      assert.equal(await readFile(join(call,'ready'),'utf8'),'1');
      const pid=Number(await readFile(join(call,'pid'),'utf8')); assert.ok(Number.isSafeInteger(pid)&&pid>0);
      await poll(async()=>pidAlive(pid),(alive)=>!alive,'AI 工具实际退出');
      let normalExit:string|null=null;
      try {normalExit=await readFile(join(call,'normal-exit'),'utf8');} catch { /* 取消时可以直接回收工具。 */ }
      return {index,pid,started:true,alive:false,normal_exit:normalExit,argv:await this.args(index),input_bytes:await this.input(index),
        host_token_inherited:(await readFile(join(call,'host-token-inherited'),'utf8'))==='true'};
    },
  };
}
export async function deploy(root:string,id:string,configuration:unknown,binDirectory=join(backend,'target/debug')) {
  assert.ok(['settings','ai-assistant','tool-supply'].includes(id));
  const directory=join(root,'plugins',id);await mkdir(directory,{recursive:true});
  const executable=join(directory,`deviceforge-${id}-plugin${suffix}`);
  await copyFile(join(binDirectory,`deviceforge-${id}-plugin${suffix}`),executable);
  const manifest=JSON.parse(await readFile(join(backend,'plugins',id,'manifest.json'),'utf8'));
  assert.equal(manifest.id,id); assert.equal(manifest.protocol_version,4); assert.ok(manifest.executable);
  manifest.executable=executable;manifest.args=[];
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(directory,`${id}.config.json`),JSON.stringify(configuration));return {directory,manifest};
}
export async function host(root:string,binDirectory=join(backend,'target/debug')) {
  const selected=await port();const base=`http://127.0.0.1:${selected}`;const token=randomBytes(32).toString('hex');
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(APK_|DEVICEFORGE_)/i.test(key)));
  const env={...inherited,APK_API_TOKEN:token,APK_BIND:`127.0.0.1:${selected}`,APK_DATA_DIR:join(root,'data'),APK_PLUGIN_DIR:join(root,'plugins'),
    APK_BROWSER_PLUGIN_DIR:join(root,'browser-plugins'),DEVICEFORGE_HTTP_RATE:'10000'};
  const child=spawn(join(binDirectory,`apk-server${suffix}`),[],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  // 原始日志不落盘，也不进入错误摘要，仅保留字节计数。
  let stderrBytes=0;child.stderr.on('data',(part:Buffer)=>{stderrBytes+=part.length;});
  let spawnError:Error|undefined;child.on('error',(error)=>{spawnError=error;});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done)=>child.once('close',(code,signal)=>done({code,signal})));
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const requests:{transport:string;action:string;status:number;log_id:string}[]=[];
  async function request(path:string,body?:unknown) {
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const envelope=object(await response.json());const logId=response.headers.get('x-deviceforge-log-id');
    assert.ok(logId&&/^[\da-f-]{36}$/.test(logId));assert.equal(envelope.log_id,logId);
    requests.push({transport:'http',action:path,status:response.status,log_id:logId});
    return {response,json:envelope.data,error:envelope.error,logId};
  }
  let rpc=0;
  async function mcp(name:string,args:unknown) {
    const response=await fetch(base+'/mcp',{method:'POST',headers:{...headers,accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);const raw=object(await response.json());assert.equal(raw.id,rpc);
    const result=object(raw.result);const logId=response.headers.get('x-deviceforge-log-id');
    assert.ok(logId&&/^[\da-f-]{36}$/.test(logId));assert.equal(object(result._meta)['deviceforge/log_id'],logId);
    requests.push({transport:'mcp',action:name,status:response.status,log_id:logId});
    assert.equal(result.isError,false,'MCP 业务调用失败');return result.structuredContent;
  }
  async function submit(operation:string,input:unknown,viaMcp=false) {
    if(viaMcp)return mcp(operation,input);
    const {response,json}=await request('/api/v2/jobs',{operation,input});assert.equal(response.status,202,'HTTP 提交任务失败');return object(json);
  }
  async function finished(id:string) {
    const end=Date.now()+15000;
    while(Date.now()<end){const {response,json}=await request(`/api/v2/jobs/${id}`);assert.equal(response.status,200);const job=object(json);if(['succeeded','failed','cancelled'].includes(String(job.status)))return job;await sleep(25);}
    throw new Error('宿主任务未在驱动期限内完成');
  }
  async function run(operation:string,input:unknown,viaMcp=false){return finished(String(object(await submit(operation,input,viaMcp)).id));}
  async function ready() {
    const end=Date.now()+15000;
    while(Date.now()<end){if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('真实宿主提前退出');try {if((await request('/api/v2/health')).response.ok)return;}catch{}await sleep(50);}
    throw new Error('真实宿主未启动');
  }
  async function close(){
    let forced=false;let shutdownAccepted=false;
    if(child.exitCode===null && !spawnError){
      try{const reply=await request('/api/v2/system/shutdown',{});shutdownAccepted=reply.response.status===200&&object(reply.json).stopping===true;}catch{/* 清理失败仍写报告。 */}
      const graceful=await Promise.race([closed,sleep(12000).then(()=>null)]);
      if(graceful===null){forced=true;child.kill('SIGKILL');}
    }
    const exit=await Promise.race([closed,sleep(5000).then(()=>null)]);
    const released=await portReleased(selected);
    return {pid:child.pid,exitCode:exit?.code??null,signal:exit?.signal??null,forced,shutdown_accepted:shutdownAccepted,port_released:released,stderrBytes};
  }
  async function shared(id:string) {
    const reply=await request(`/api/v2/jobs/${id}`);assert.equal(reply.response.status,200);
    const http=object(reply.json);const other=object(await mcp('deviceforge.get_job',{id}));
    assert.deepEqual(other,http,'HTTP/MCP 必须读取同一 Job');return http;
  }
  async function cancel(id:string,viaMcp=false) {
    if(viaMcp)return mcp('deviceforge.cancel_job',{id});
    const reply=await request(`/api/v2/jobs/${id}/cancel`,{});assert.equal(reply.response.status,200);return reply.json;
  }
  async function manage(id:string,action:'load'|'unload',viaMcp=false) {
    if(viaMcp)return mcp(`deviceforge.${action}_plugin`,{id});
    const reply=await request(`/api/v2/plugins/${id}/${action}`,{});assert.equal(reply.response.status,200);return reply.json;
  }
  return {base,request,mcp,submit,finished,run,ready,close,shared,cancel,manage,requests};
}
export type Host=Awaited<ReturnType<typeof host>>;
export function value(job:JsonObject){assert.equal(job.status,'succeeded','业务任务未成功');const result=object(job.result);assert.ok(Array.isArray(result.artifacts));return object(result.result);}
