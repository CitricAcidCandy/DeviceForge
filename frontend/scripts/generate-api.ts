import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const manifest = fileURLToPath(new URL('../../backend/Cargo.toml', import.meta.url));
const result = spawnSync('cargo', ['run', '--quiet', '--manifest-path', manifest, '-p', 'apk-server', '--bin', 'export-openapi'], { encoding: 'utf8' });
if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || '接口模式导出失败');
// 字符串输入由生成器的公开解析边界校验，避免把 JSON.parse 的返回值传为隐式宽类型。
const ast = await openapiTS(result.stdout);
const banner = '// 此文件从 Rust 公开接口模式生成，请通过 npm run generate:api 更新。\n';
// 去除上游说明后清理残留行尾空白，生成过程始终保持可重复。
const types = astToString(ast).replace(/\/\*[\s\S]*?\*\//g, '').replace(/[\t ]+$/gm, '');
await writeFile(new URL('../src/shared/api/generated.ts', import.meta.url), banner + types, 'utf8');
console.log('公开接口类型已生成');

