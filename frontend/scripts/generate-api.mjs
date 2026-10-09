import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const manifest = fileURLToPath(new URL('../../backend/Cargo.toml', import.meta.url));
const result = spawnSync('cargo', ['run', '--quiet', '--manifest-path', manifest, '-p', 'apk-server', '--bin', 'export-openapi'], { encoding: 'utf8' });
if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || '接口模式导出失败');
const ast = await openapiTS(JSON.parse(result.stdout));
const banner = '// 此文件从 Rust 公开接口模式生成，请通过 npm run generate:api 更新。\n';
await writeFile(new URL('../src/shared/api/generated.ts', import.meta.url), banner + astToString(ast).replace(/\/\*[\s\S]*?\*\//g, ""), 'utf8');
console.log('公开接口类型已生成');

