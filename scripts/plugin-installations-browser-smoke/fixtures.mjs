// 在共享发布夹具生成的本轮文件上替换浏览器组件，不修改共享生成器。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { releaseFixture } from '../plugin-installations-smoke/fixtures.mjs';
import { packRelease } from '../plugin-releases/pack.mjs';

export async function browserReleaseFixture(root, options = {}) {
  const fixture = await releaseFixture(root, options);
  const directory = join(root, `${fixture.id}-${fixture.version}`);
  const descriptor = { name: `smoke-${fixture.id}-browser`, version: fixture.version, type: 'module', deviceforge: {
    kind: 'browser', manifest: 'plugin.json', entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
  } };
  const script = `export default {id:${JSON.stringify(fixture.browserId)},version:${JSON.stringify(fixture.version)},apiVersion:2,panels:[],
async activate(host){
 const key=${JSON.stringify(fixture.id)},state=globalThis.__installationBrowserSmoke??={attempts:0,cleanups:0,runs:[]};
 state.attempts++;
 if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,'retry');throw new Error('验收夹具首次激活失败，请重试本客户端');}
 host.onDispose(()=>{state.cleanups++;});
 const result=await host.submit(${JSON.stringify(`plugin.${fixture.serverId}.inspect`)},{},host.signal);
 let job=result.data;
 while(job.status==='queued'||job.status==='running'){
  await new Promise(done=>setTimeout(done,30));job=(await host.getJob(job.id,host.signal)).data;
 }
 if(job.status!=='succeeded')throw new Error('真实插件检查任务失败');
 state.runs.push({version:${JSON.stringify(fixture.version)},result:job.result,logId:result.logId});
}};\n`;
  await writeFile(join(directory, 'browser.tgz'), npmTgz([
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    { path: 'plugin.json', bytes: JSON.stringify({ id: fixture.browserId, version: fixture.version, api_version: 2 }) },
    { path: 'dist/index.js', bytes: script },
  ]));
  const source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'));
  source.name = '浏览器验收第三方功能'; source.description = '第三方服务器、浏览器与共享工具组成的真实完整发布';
  await writeFile(join(directory, 'source.json'), JSON.stringify(source));
  const metadata = JSON.parse(await readFile(fixture.market, 'utf8'));
  metadata.name = source.name; metadata.description = source.description; metadata.summary = '配置、启停与浏览器重试验收';
  await writeFile(fixture.market, JSON.stringify(metadata));
  const output = join(directory, 'browser-release');
  const packed = await packRelease({ source: join(directory, 'source.json'), inputs: join(directory, 'inputs.json'), destination: output, platform: 'win32-x64' });
  return { ...fixture, directory: output, ...packed };
}
