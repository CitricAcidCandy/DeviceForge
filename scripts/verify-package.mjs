import { fileURLToPath } from 'node:url';
import { readJson } from '../cli/src/paths.mjs';
import { loadRuntime } from '../cli/src/runtime.mjs';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = await readJson(join(root, 'package.json'));
const runtime = await loadRuntime(root);
if (runtime.version !== pkg.version) throw new Error('CLI 与运行包版本不一致，请重新构建运行包');
// npm pack --json 的标准输出必须保持可解析，门禁摘要写入标准错误。
console.error('npm 包门禁通过：当前平台入口、摘要、版本和静态首页有效');
