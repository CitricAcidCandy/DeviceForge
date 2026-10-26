// 参数只接受独占新目录和显式冻结输入，不推导正在变化的 target 产物。
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const help = `插件依赖真实 HTTP/MCP 验收（不编译、不生成 API、不连接预览）
用法：
  node scripts/plugin-dependencies-smoke.mjs --prepare-only [--output-directory 新目录]
  node scripts/plugin-dependencies-smoke.mjs --binary-directory 冻结宿主目录 [--output-directory 新目录]
  node scripts/plugin-dependencies-smoke.mjs --binary-path 冻结宿主exe [--output-directory 新目录]
  node scripts/plugin-dependencies-smoke/self-test.mjs
参数：
  --binary-directory   包含 apk-server.exe 的冻结目录；实际运行时必填
  --binary-path        显式指定冻结宿主 exe；与 --binary-directory 二选一
  --output-directory   尚不存在的证据目录，保留全部失败原件
  --prepare-only       只准备归档和验收计划，不启动宿主或 HTTP 下载源
  --help              显示说明
npx 持久化、真实市场服务、浏览器执行和真机不计入本夹具通过范围。`;

export function options(args) {
  const value = { prepareOnly: false, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert.ok(!seen.has(key), `参数重复：${key}`);
    seen.add(key);
    if (key === '--prepare-only') value.prepareOnly = true;
    else if (key === '--help') value.help = true;
    else if (['--binary-directory', '--binary-path', '--output-directory'].includes(key)) {
      const path = args[++index];
      assert.ok(path && !path.startsWith('--'), `${key} 缺少路径`);
      const field = { '--binary-directory': 'binaryDirectory', '--binary-path': 'binaryPath', '--output-directory': 'outputDirectory' }[key];
      value[field] = resolve(path);
    } else throw new Error(`未知参数：${key}`);
  }
  assert.ok(!(value.binaryDirectory && value.binaryPath), '冻结目录与冻结 exe 路径不能同时指定');
  assert.ok(!value.prepareOnly || !(value.binaryDirectory || value.binaryPath), '准备模式不接受将被忽略的宿主路径');
  assert.ok(value.help || value.prepareOnly || value.binaryDirectory || value.binaryPath, '实际运行必须显式指定冻结宿主目录或 exe 路径');
  return value;
}
