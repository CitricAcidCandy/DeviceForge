import { npmTgz } from '../backend/scripts/online-plugins/fixtures.mjs';
import { readFile } from 'node:fs/promises';

// 使用交付给插件开发者的真实独立示例，不在验收页手写提供者对象。
export async function deviceProviderFixture() {
  const directory = new URL('../backend/examples/device-provider-node/', import.meta.url);
  const files = await Promise.all(['package.json', 'plugin.json', 'index.mjs', 'README.md'].map(async path => ({
    path, bytes: await readFile(new URL(path, directory)),
  })));
  return { id: 'device_node_example', archive: npmTgz(files) };
}

// 插件依赖和界面内容全部来自真实上传包，测试页不直接登记模块对象。
export function browserRuntimeFixture() {
  const id = 'browser_runtime_probe';
  const descriptor = { name: 'deviceforge-browser-runtime-probe', version: '1.0.0', type: 'module',
    deviceforge: { kind: 'browser', manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } } };
  const shared = `// 每个运行路径应执行独立的相对依赖模块。
export const dependencyRun = crypto.randomUUID();
export function render(target, text) {
  const label = target.ownerDocument.createElement('span');
  label.textContent = text; target.append(label);
  return () => label.remove();
}
`;
  const module = `import {dependencyRun, render} from './shared.js';
const settings = await fetch(new URL('./settings.json', import.meta.url)).then(response => response.json());
export default {
  id: '${id}', version: '1.0.0', apiVersion: 2,
  panels: [{id:'${id}.panel', title:'在线面板', async mount(target) {return render(target, settings.panel);}}],
  async activate(context) {
    context.extensions.setState('${id}.ready', true);
    context.extensions.register({commands:[{id:'${id}.dynamic',title:'动态命令',async execute(input, current, signal) {
      const reply = await current.listOperations(signal);
      return {data:{ready:current.extensions.getState('${id}.ready'),dependencyRun},logId:reply.logId};
    }}]});
  },
  contributions: {
    components:[{id:'${id}.component',title:'替换组件',slot:'toolbar',mode:'replace',async mount(target) {return render(target, settings.component);}}],
    modules:[{id:'${id}.module',title:'新增模块',route:'/probe',async mount(target) {return render(target, settings.module);}}],
    commands:[{id:'${id}.command',title:'服务对接',async execute(input, context, signal) {
      const reply=await context.listOperations(signal); return {data:{dependencyRun,count:reply.data.length},logId:reply.logId};
    }},{id:'${id}.devices',title:'公开设备能力对接',async execute(input, context, signal) {
      if(!context.devices) throw new Error('宿主缺少公开设备能力');
      const providers=await context.devices.refreshProviders(signal);
      const provider=providers.data.find(item=>item.id==='device_node_example');
      if(!provider) throw new Error('模拟设备提供者未加载');
      const directory=await context.devices.refreshProvider(provider.id,provider.generation,signal);
      const device=directory.data.devices.find(item=>item.reference.localId==='demo-device');
      if(!device) throw new Error('模拟设备未被发现');
      const reply=await context.devices.invoke({providerId:provider.id,generation:provider.generation,
        deviceId:device.reference.localId,capability:'device.echo',version:1,input:{source:'browser-plugin'}},signal);
      return {data:{jobId:reply.data.id,reference:device.reference},logId:reply.logId};
    }}],
    services:[{id:'${id}.service',version:'1',async invoke(input, context, signal) {
      return context.extensions.executeCommand('${id}.command',input,signal);
    }}],
    beforeTaskSubmit:[{id:'${id}.hook',priority:1,async transform(submission) {
      if(submission.operation!=='plugin.online_echo_v2.echo') return submission;
      return {operation:submission.operation,input:{...submission.input,value:submission.input.value+1}};
    }}]
  }
};
`;
  const files = [
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    { path: 'plugin.json', bytes: JSON.stringify({ id, version: '1.0.0', api_version: 2 }) },
    { path: 'dist/index.js', bytes: module },
    { path: 'dist/shared.js', bytes: shared },
    { path: 'dist/settings.json', bytes: JSON.stringify({ panel: '在线面板已挂载', component: '在线组件替换宿主', module: '在线模块已挂载' }) },
  ];
  return { id, archive: npmTgz(files) };
}
