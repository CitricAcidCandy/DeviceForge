import assert from 'node:assert/strict';
import { action } from './actions.mjs';
import { catalog } from './bootstrap.mjs';
import { discover } from './discovery.mjs';
import { operation, pluginId } from './deployment.mjs';
import { keys, observations, otherId, setMode, started } from './fixtures.mjs';
import { jobList, uuid } from './jobs.mjs';
import { owner, plugins } from './lifecycle.mjs';
import { finishSample, sampleArgv, sampleCapability, sampleGroups, waitSamples } from './performance-fixtures.mjs';
import { sessionJob } from './performance.mjs';

function source(value, provider, request) {
  assert.match(value.id,uuid); assert.deepEqual(value.request,request);
  assert.deepEqual(value.source,{plugin_id:pluginId,generation:provider.generation,operation:operation(sampleCapability),
    device:{provider_id:pluginId,generation:provider.generation,local_id:request.target.device_id}});
}

async function startSession(host,report,packageName,transport,interval = 1000) {
  const request = {target:{device_id:otherId,package:packageName},interval_ms:interval,duration_secs:120};
  const {entry,value} = await sessionJob(host,report,'start',request,transport);
  source(value,report.provider,request); assert.equal(value.state,'running');
  const session = {id:value.id,source:structuredClone(value.source),request,start_job_id:entry.job_id,last_history:value};
  report.performance.sessions.push(session); return session;
}

function sameSource(session,value) {
  assert.equal(value.id,session.id); assert.deepEqual(value.source,session.source); assert.deepEqual(value.request,session.request);
}

async function inspect(host,report,session,transport,state) {
  const {value} = await sessionJob(host,report,'inspect',{session_id:session.id},transport);
  sameSource(session,value); assert.equal(value.state,state); session.last_history=value; return value;
}

async function control(host,report,session,name,transport,state) {
  const {value} = await sessionJob(host,report,name,{session_id:session.id},transport);
  sameSource(session,value); assert.equal(value.state,state); session.last_history=value; return value;
}

async function page(host,report,session,transport,after=0) {
  const {value} = await sessionJob(host,report,'samples',{session_id:session.id,after,limit:100},transport);
  sameSource(session,value.session); assert.equal(value.next_after,after+value.readings.length);
  assert.equal(value.readings.length,Math.min(100,Math.max(0,value.session.samples-after)),'AD-PERF-STORED-READINGS');
  for (const [index,reading] of value.readings.entries()) {
    assert.equal(reading.sequence,after+index+1); assert.equal(reading.pid,2468); assert.equal(reading.logical_cpus,2);
    assert.equal(reading.pss_kib,2048); assert.equal(reading.rss_kib,4096); assert.equal(reading.fps,undefined); assert.equal(reading.frame_window,undefined);
  }
  return value;
}

async function settle(fixture,packageName) {
  const groups = sampleGroups((await observations(fixture)).filter(item=>item.ready.sample_package===packageName));
  return Promise.all(groups.map(group=>finishSample(group,{packageName,partial:true})));
}

async function retainSamples(fixture,report,session) {
  const groups = await settle(fixture,session.request.target.package);
  for (const group of groups) report.performance.sample_groups.push({...group,session_id:session.id,source:session.source});
  assert.ok(groups.filter(group=>group.complete).length>=session.last_history.samples);
  session.observed_sample_groups=groups.length;
}

async function ordinarySession(host,fixture,report) {
  for (const transport of ['http','mcp']) {
    const {value} = await sessionJob(host,report,'capabilities',{},transport);
    assert.equal(value.source,'plugin.'+pluginId); assert.equal(value.fps,false);
    assert.equal(value.scope,'main_process'); assert.equal(value.max_samples,3600); assert.equal(value.sample_timeout_ms,10000);
  }
  // 直接采样及缺来源start都不得创建会话历史。
  const empty = (await sessionJob(host,report,'list',{after_id:null,limit:100},'http')).value;
  assert.deepEqual(empty,{sessions:[],next_after_id:null});
  const session=await startSession(host,report,'org.smoke.performance.flow','http');
  await waitSamples(fixture,session.request.target.package,2);
  await control(host,report,session,'pause','mcp','paused'); await settle(fixture,session.request.target.package);
  assert.ok(session.last_history.samples>=2,'AD-PERF-INITIAL-STORED-SAMPLES');
  await inspect(host,report,session,'http','paused');
  const first=await page(host,report,session,'mcp'); assert.ok(first.readings.length>=2);
  assert.equal(first.readings[0].cpu_share_percent,null); assert.equal(first.readings[0].cpu_core_percent,null);
  assert.ok(Math.abs(first.readings[1].cpu_share_percent-10)<0.000001);
  assert.ok(Math.abs(first.readings[1].cpu_core_percent-20)<0.000001);
  const listed=(await sessionJob(host,report,'list',{after_id:null,limit:100},'mcp')).value;
  assert.equal(listed.sessions.length,1); sameSource(session,listed.sessions[0]);
  let count=(await settle(fixture,session.request.target.package)).filter(group=>group.complete).length;
  await control(host,report,session,'resume','http','running');
  await waitSamples(fixture,session.request.target.package,count+1);
  await control(host,report,session,'pause','http','paused'); await settle(fixture,session.request.target.package);
  assert.ok(session.last_history.samples>first.next_after,'AD-PERF-RESUMED-STORED-SAMPLES');
  await inspect(host,report,session,'mcp','paused');
  const resumed=await page(host,report,session,'http',first.next_after); assert.ok(resumed.readings.length>=1);
  assert.equal(resumed.readings[0].cpu_share_percent,null); assert.equal(resumed.readings[0].cpu_core_percent,null);
  count=(await settle(fixture,session.request.target.package)).filter(group=>group.complete).length;
  const storedBeforeResume=session.last_history.samples;
  await control(host,report,session,'resume','mcp','running');
  await waitSamples(fixture,session.request.target.package,count+1);
  const stopped=await control(host,report,session,'stop','http','stopped'); await settle(fixture,session.request.target.package);
  assert.ok(stopped.samples>storedBeforeResume,'AD-PERF-SECOND-RESUME-STORED-SAMPLES');
  assert.deepEqual(await control(host,report,session,'stop','mcp','stopped'),stopped);
  await retainSamples(fixture,report,session); session.reading_pages=[first,resumed];
  report.checks.push({name:'PERF八会话入口HTTP/MCP、无直接采样历史、两次暂停排空/恢复、真实CPU差分与恢复基线清空、stop幂等',passed:true});
  return session;
}

async function unload(host,deployment,fixture,report,session) {
  const generation=session.source.generation;
  owner(await host.client.tool('deviceforge.unload_plugin',{id:pluginId}),deployment,generation,'unloaded');
  await plugins(host); await catalog(host,deployment,report,'PERF会话卸载',false);
  assert.deepEqual(await host.client.json('/api/v2/devices'),[]);
  const before=await jobList(host), prior=await keys(fixture), input={device_id:otherId,input:{package:session.request.target.package}};
  await host.client.post('/api/v2/jobs',{operation:operation(sampleCapability),input},{status:404,code:'not_found'});
  await host.client.tool(operation(sampleCapability),input,'not_found');
  assert.deepEqual(await jobList(host),before); assert.deepEqual(await keys(fixture),prior);
}

async function reload(host,deployment,fixture,report,oldSession,label) {
  const loaded=owner(await host.client.post('/api/v2/plugins/'+pluginId+'/load'),deployment,undefined,'loaded');
  assert.notEqual(loaded.generation,oldSession.source.generation);
  report.performance.lifecycle_generations ??=[];
  report.performance.lifecycle_generations.push({phase:label,old:oldSession.source.generation,current:loaded.generation});
  await plugins(host,loaded); await catalog(host,deployment,report,'PERF新代-'+label,true,loaded);
  const before=await jobList(host), tools=await keys(fixture);
  const stale=action({...report.provider,generation:oldSession.source.generation},sampleCapability,otherId,{package:oldSession.request.target.package});
  await host.client.post('/api/v2/device-actions',stale,{status:409,code:'conflict'});
  await host.client.tool('deviceforge.invoke_device',stale,'conflict');
  assert.deepEqual(await jobList(host),before); assert.deepEqual(await keys(fixture),tools);
  const discovery=await discover(host,deployment,fixture,report,{phase:'PERF重载-'+label}); discovery.inventory_group='performance';
}

export async function performanceSessions(host,deployment,fixture,report) {
  const ordinary=await ordinarySession(host,fixture,report);
  let before=await keys(fixture); await setMode(fixture,'hold');
  const running=await startSession(host,report,'org.smoke.performance.running','mcp',60000);
  await started(fixture,before,sampleArgv(running.request.target.package)[0]);
  await unload(host,deployment,fixture,report,running); await inspect(host,report,running,'http','interrupted');
  await retainSamples(fixture,report,running);
  const rejected=await sessionJob(host,report,'resume',{session_id:running.id},'mcp','failed');
  assert.equal(rejected.entry.history.result,null); assert.ok(rejected.entry.history.error);
  const unavailable=await sessionJob(host,report,'capabilities',{},'http','failed');
  assert.equal(unavailable.entry.history.error,'资源不存在：性能采样源不可用');
  await setMode(fixture,'normal'); await reload(host,deployment,fixture,report,running,'Running');

  before=await keys(fixture); await setMode(fixture,'hold');
  const paused=await startSession(host,report,'org.smoke.performance.paused','mcp',60000);
  await started(fixture,before,sampleArgv(paused.request.target.package)[0]);
  await control(host,report,paused,'pause','http','paused'); await settle(fixture,paused.request.target.package);
  await unload(host,deployment,fixture,report,paused); await inspect(host,report,paused,'mcp','interrupted');
  await retainSamples(fixture,report,paused);
  await setMode(fixture,'normal'); await reload(host,deployment,fixture,report,paused,'Paused');

  const current=await startSession(host,report,'org.smoke.performance.new_generation','http');
  assert.notEqual(current.source.generation,paused.source.generation); assert.notEqual(current.source.generation,running.source.generation);
  await waitSamples(fixture,current.request.target.package);
  await control(host,report,current,'stop','mcp','stopped'); await retainSamples(fixture,report,current);
  assert.ok(current.last_history.samples>=1,'AD-PERF-NEW-GENERATION-STORED-SAMPLES');
  owner(await host.client.post('/api/v2/plugins/'+pluginId+'/unload'),deployment,current.source.generation,'unloaded');
  await plugins(host); await catalog(host,deployment,report,'PERF最终卸载',false);

  const final=(await sessionJob(host,report,'list',{after_id:null,limit:100},'http')).value;
  assert.equal(final.sessions.length,4); assert.equal(final.next_after_id,[...report.performance.sessions.map(session=>session.id)].sort().at(-1));
  for (const session of report.performance.sessions) {
    const actual=final.sessions.find(item=>item.id===session.id); assert.ok(actual); sameSource(session,actual);
    assert.deepEqual(actual,session.last_history,'PERF终态和不可变来源历史');
  }
  const finalPage=await page(host,report,ordinary,'http'); assert.deepEqual(finalPage.session,ordinary.last_history);
  for (const previous of ordinary.reading_pages) {
    assert.deepEqual(finalPage.readings.filter(reading=>reading.sequence>previous.readings[0].sequence-1
      && reading.sequence<=previous.next_after),previous.readings);
  }
  ordinary.final_page=finalPage; report.performance.final_sessions=final;
  report.checks.push({name:'PERF-Running及Paused卸载Interrupted、直接PID排空、两轮换代、旧代拒绝、旧会话不续和完整来源/分页历史',passed:true});
}
