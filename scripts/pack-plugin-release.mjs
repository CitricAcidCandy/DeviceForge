#!/usr/bin/env node
// 参数入口只负责装配，不承担归档、依赖或发布规则。
import { packRelease } from './plugin-releases/pack.mjs';
import { planPublication, publishRelease } from './plugin-releases/publish.mjs';

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === '--help') {
    console.log(
      '用法：node scripts/pack-plugin-release.mjs pack --source release.json --inputs inputs.json --destination 新目录 [--platform win32-x64]\n      node scripts/pack-plugin-release.mjs plan --directory 目录 --market market.json --server http://127.0.0.1:7040\n      node scripts/pack-plugin-release.mjs publish --directory 目录 --market market.json --server 地址',
    );
    return;
  }
  const options = {},
    allowed =
      command === 'pack'
        ? ['source', 'inputs', 'destination', 'platform']
        : ['directory', 'market', 'server'];
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.slice(2);
    if (
      !rest[index]?.startsWith('--') ||
      !allowed.includes(name) ||
      Object.hasOwn(options, name) ||
      !rest[index + 1]
    )
      throw new Error('发布参数无效或重复');
    options[name] = rest[index + 1];
  }
  if (command === 'pack') {
    if (!options.source || !options.inputs || !options.destination)
      throw new Error('打包缺少源清单、真实输入或新输出目录');
    console.log(JSON.stringify(await packRelease(options), null, 2));
  } else if (['plan', 'publish'].includes(command)) {
    if (!options.directory || !options.market || !options.server)
      throw new Error('发布缺少目录、市场元数据或服务器地址');
    const plan = await planPublication(options);
    console.log(
      JSON.stringify(command === 'publish' ? await publishRelease(plan) : plan.summary, null, 2),
    );
  } else throw new Error('未知发布命令');
}
if (
  import.meta.url === new URL(process.argv[1], 'file:///').href ||
  process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/pack-plugin-release.mjs')
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
