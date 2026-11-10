import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import ts from 'typescript';
import { archiveInstalledSdkPackage } from '../scripts/installed-sdk-package.ts';

const frontend = resolve(import.meta.dirname, '..');

async function entries() {
  const { archive } = await archiveInstalledSdkPackage(frontend, 'contracts', join(frontend, 'artifacts/installed-sdk'));
  const values = new Map<string, Buffer>();
  for await (const entry of extract()([gunzipSync(await readFile(archive))])) {
    assert.match(entry.header.name, /^package\/(?:package\.json|api\.d\.ts|README\.md)$/);
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    values.set(entry.header.name.slice('package/'.length), Buffer.concat(chunks));
  }
  return values;
}

test('公开 HTTP 类型真实归档只含独立声明，与唯一生成结果逐字节一致', async () => {
  const values = await entries();
  assert.equal(values.size, 3);
  const declaration = values.get('api.d.ts');
  assert.ok(declaration);
  assert.ok(declaration.equals(await readFile(join(frontend, 'src/services/api/generated.ts'))));
  const metadata = values.get('package.json'); assert.ok(metadata);
  const info: unknown = JSON.parse(metadata.toString('utf8'));
  assert.ok(info && typeof info === 'object' && 'name' in info && 'private' in info);
  assert.equal(info.name, '@deviceforge/contracts');
  assert.equal(info.private, true);
});

test('独立 NodeNext 工程可从实际 TGZ 严格解析 HTTP 类型，不读取宿主源码', async () => {
  await mkdir(join(frontend, 'artifacts'), { recursive: true });
  const temporary = await mkdtemp(join(frontend, 'artifacts/deviceforge-contracts-consumer-'));
  const root = join(temporary, 'node_modules/@deviceforge/contracts');
  try {
    for (const [name, bytes] of await entries()) {
      const destination = resolve(root, name);
      assert.ok(destination.startsWith(resolve(root) + sep));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
    const file = join(temporary, 'index.ts');
    await writeFile(file, [
      'import type { paths } from "@deviceforge/contracts/api";',
      'export type Route = keyof paths;',
      'export function accept(route: Route): Route { return route; }',
    ].join('\n'));
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, strict: true, exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true, noEmit: true, types: [],
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
    assert.equal(program.getSourceFiles().some((source) => source.fileName.startsWith(join(frontend, 'src'))), false);
  } finally {
    const checked = resolve(temporary);
    assert.ok(checked.startsWith(resolve(frontend, 'artifacts') + sep));
    await rm(checked, { recursive: true, force: true });
  }
});
