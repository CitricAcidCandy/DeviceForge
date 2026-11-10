import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import ts from 'typescript';
import type { HostResult, Job, ServerServiceAccess } from '../src/plugin-sdk/index.ts';
import { generatePluginContracts } from '@deviceforge/plugin-tools';
import { archiveInstalledSdkPackage } from '../scripts/installed-sdk-package.ts';


function schema() {
  return {
    type: 'object',
    properties: { message: { type: 'string', maxLength: 1000 } },
    required: ['message'], additionalProperties: false,
  };
}
function provided(id = 'example.workspace.normalize', version = '1', operation = 'normalize') {
  return { service: { id, version }, operation,
    contract: { input_schema: schema(), output_schema: schema() } };
}
function manifest(services: readonly unknown[] = [provided()]) {
  return {
    manifest_version: 1, id: 'workspace_suite', version: '0.1.0', name: '独立配套示例',
    description: '单清单公开契约生成',
    components: [
      { kind: 'server', plugin: { protocol_version: 1, operations: [
        { name: 'normalize', title: '规范化消息', input_schema: schema() },
      ], services: { provided: services, required: [] } } },
      { kind: 'browser', plugin: { api_version: 2 } },
    ],
  };
}
function schemaManifest(input: unknown, output: unknown = input) {
  return {
    ...manifest(),
    components: [
      { kind: 'server', plugin: { operations: [{ name: 'normalize', input_schema: input }],
        services: { provided: [{
          ...provided(), contract: { input_schema: input, output_schema: output },
        }] } } },
      { kind: 'browser', plugin: { api_version: 2 } },
    ],
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function moduleSource(source: string) {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const loaded: unknown = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
  assert.ok(object(loaded));
  return loaded;
}

test('单清单生成稳定服务身份、Schema和输入输出类型，公开输出不依赖宿主', () => {
  const input = manifest(), before = JSON.stringify(input);
  const generated = generatePluginContracts(input);
  assert.deepEqual(generated.services, [{
    id: 'example.workspace.normalize', version: '1',
    operation: 'plugin.workspace_suite.server.normalize', exportName: 'ExampleWorkspaceNormalizeV1',
  }]);
  assert.match(generated.source, /export type ExampleWorkspaceNormalizeV1Input =/u);
  assert.match(generated.source, /export type ExampleWorkspaceNormalizeV1Output =/u);
  assert.match(generated.source, /export const ExampleWorkspaceNormalizeV1Ref: ServiceRef/u);
  assert.match(generated.source, /export const ExampleWorkspaceNormalizeV1Schema: ServiceContract/u);
  assert.match(generated.source, /export const ExampleWorkspaceNormalizeV1: ServiceContract/u);
  assert.match(generated.source, /export function ExampleWorkspaceNormalizeV1Submit\(/u);
  assert.equal(JSON.stringify(input), before);
  const source = ts.createSourceFile('contracts.ts', generated.source, ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(ts.isImportDeclaration);
  assert.equal(imports.length, 1);
  assert.equal(imports[0]?.importClause?.isTypeOnly, true);
  assert.equal(imports[0]?.moduleSpecifier.getText(source), '"@deviceforge/plugin-sdk"');
  assert.doesNotMatch(generated.source, /(?:\.\.\/src|[A-Z]:\\|from\s+["']node:)/u);
});

test('服务顺序与JSON键顺序不影响生成结果，重复服务和导出名称碰撞明确拒绝', () => {
  const one = provided('example.first'), two = provided('example.second', '2');
  const reverse: unknown = JSON.parse(JSON.stringify(manifest([two, one]), (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).reverse());
    return value;
  }));
  assert.deepEqual(generatePluginContracts(manifest([one, two])), generatePluginContracts(reverse));
  assert.throws(() => generatePluginContracts(manifest([one, one])), /重复/u);
  assert.throws(() => generatePluginContracts(manifest([
    provided('example.normal-ize'), provided('example.normal_ize'),
  ])), /导出名称.*碰撞/u);
});

test('服务描述对象与其他服务派生Ref、Schema、Submit或类型重名时明确拒绝', () => {
  for (const suffix of ['Ref', 'Schema', 'Submit', 'Input', 'Output'])
    assert.throws(() => generatePluginContracts(manifest([
      provided('example.service', '1'), provided('example.service', '1' + suffix),
    ])), /导出名称.*碰撞/u);
});

test('非法操作映射与不支持的Schema明确失败，不生成any或unknown占位', () => {
  assert.throws(() => generatePluginContracts(manifest([provided('example.invalid', '1', 'absent')])), /操作/u);
  assert.throws(() => generatePluginContracts(manifest([{
    ...provided(), contract: { input_schema: { $ref: '#/$defs/Input' }, output_schema: schema() },
  }])), /\$ref/u);
  assert.throws(() => generatePluginContracts(manifest([{
    ...provided(), contract: { input_schema: { type: 'array', prefixItems: [{ type: 'string' }] },
      output_schema: schema() },
  }])), /prefixItems/u);
});

test('操作输入Schema键顺序可不同，真实约束漂移必须拒绝', () => {
  const same = manifest();
  const operation = same.components[0]?.plugin.operations?.[0];
  assert.ok(operation);
  operation.input_schema = { additionalProperties: false, required: ['message'],
    properties: { message: { maxLength: 1000, type: 'string' } }, type: 'object' };
  assert.equal(generatePluginContracts(same).services.length, 1);
  operation.input_schema.properties.message.maxLength = 999;
  assert.throws(() => generatePluginContracts(same), /input_schema.*不一致/u);
});

test('常见结构与约束保留原Schema，空对象、开放对象和字典不扩大为非JSON数据', async () => {
  const input = {
    type: 'object', additionalProperties: false, required: ['mode', 'samples', 'settings', 'empty'],
    properties: {
      mode: { enum: ['compact', 'full'] },
      message: { type: ['string', 'null'], minLength: 1, maxLength: 1000, pattern: '^.*$' },
      samples: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
        items: { type: 'integer', minimum: 0, exclusiveMaximum: 100, multipleOf: 1 } },
      settings: { type: 'object', additionalProperties: { type: 'boolean' } },
      empty: { type: 'object', additionalProperties: false },
      metadata: { type: 'object', properties: { active: { const: true } } },
    },
  };
  const generated = generatePluginContracts(schemaManifest(input));
  assert.match(generated.source, /JsonValue/u);
  const parsed = ts.createSourceFile('contracts.ts', generated.source, ts.ScriptTarget.Latest, true);
  let unbounded = false;
  function visit(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) unbounded = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(unbounded, false);
  const loaded = await moduleSource(generated.source);
  const contract = loaded['ExampleWorkspaceNormalizeV1'];
  assert.ok(object(contract));
  assert.deepEqual(contract.inputSchema, input);
  assert.deepEqual(contract.outputSchema, input);
  assert.deepEqual(contract.ref, { id: 'example.workspace.normalize', version: '1' });
});

test('非法或超出明确子集的Schema逐项拒绝，不静默删除约束', () => {
  const invalidSchemas: readonly (readonly [unknown, RegExp])[] = [
    [true, /JSON 对象/u],
    [{}, /声明类型/u],
    [{ type: 'string', format: 'uri' }, /format/u],
    [{ type: 'object', patternProperties: { '^x': { type: 'string' } } }, /patternProperties/u],
    [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, /oneOf/u],
    [{ type: ['string', 'number'] }, /包含 null/u],
    [{ type: 'object', required: ['absent'], additionalProperties: false }, /required/u],
    [{ type: 'object', required: null }, /required/u],
    [{ type: 'object', additionalProperties: null }, /additionalProperties/u],
    [{ type: 'object', properties: { name: { type: 'string' } }, additionalProperties: { type: 'number' } },
      /Schema 字典混合/u],
    [{ type: 'array' }, /items/u],
    [{ type: 'string', minLength: 2, maxLength: 1 }, /minLength/u],
    [{ type: 'number', multipleOf: 0 }, /multipleOf/u],
    [{ type: 'string', pattern: '[' }, /pattern/u],
    [{ type: 'string', minimum: 0 }, /约束关键字/u],
    [{ enum: [] }, /enum/u],
    [{ enum: ['one', 'one'] }, /重复/u],
    [{ enum: [{ nested: true }] }, /标量/u],
    [{ type: 'integer', enum: [1.5] }, /声明类型/u],
    [{ type: 'string', const: 3 }, /声明类型/u],
  ];
  for (const [value, expected] of invalidSchemas)
    assert.throws(() => generatePluginContracts(schemaManifest(value)), expected);
});

test('清单结构、缺失契约、非JSON对象与循环拒绝，不读取访问器或修改源值', () => {
  assert.throws(() => generatePluginContracts({ ...manifest(), manifest_version: 2 }), /manifest_version/u);
  assert.throws(() => generatePluginContracts({ ...manifest(), components: [] }), /components/u);
  assert.throws(() => generatePluginContracts(manifest([{
    ...provided(), contract: { input_schema: schema() },
  }])), /output_schema/u);
  assert.throws(() => generatePluginContracts(schemaManifest({ type: 'number', maximum: Infinity })), /有限/u);
  assert.throws(() => generatePluginContracts(schemaManifest(new Date())), /自定义原型/u);
  const circular: Record<string, unknown> = { type: 'object' };
  circular['properties'] = circular;
  assert.throws(() => generatePluginContracts(schemaManifest(circular)), /循环/u);
  let reads = 0;
  const accessor = { ...manifest(), get components() { reads++; return []; } };
  assert.throws(() => generatePluginContracts(accessor), /普通可枚举值/u);
  assert.equal(reads, 0);
  const value = manifest();
  Object.freeze(value.components);
  Object.freeze(value);
  assert.equal(generatePluginContracts(value).services.length, 1);
});

test('单组件与显式组件身份遵从单清单规则，无服务时生成空公开模块', () => {
  const single = manifest();
  single.components = single.components.slice(0, 1);
  assert.equal(generatePluginContracts(single).services[0]?.operation, 'plugin.workspace_suite.normalize');
  const server = single.components[0];
  assert.ok(server);
  const explicit = { ...single, components: [{ ...server, id: 'workspace_suite.custom' }] };
  assert.equal(generatePluginContracts(explicit).services[0]?.operation, 'plugin.workspace_suite.custom.normalize');
  const noServices = generatePluginContracts(manifest([]));
  assert.deepEqual(noServices.services, []);
  assert.match(noServices.source, /export \{\};/u);
  assert.doesNotMatch(noServices.source, /import/u);
  const original = manifest();
  assert.deepEqual(generatePluginContracts(original),
    generatePluginContracts({ ...original, components: [...original.components].reverse() }));
});

test('显式null清单字段不能冒充缺省，可枚举外的数组字段及生成上限明确拒绝', () => {
  const source = manifest();
  const server = source.components[0];
  assert.ok(server);
  assert.throws(() => generatePluginContracts({ ...source, components: [{ ...server, id: null }] }), /id/u);
  for (const plugin of [
    { operations: null }, { services: { provided: null } },
  ])
    assert.throws(() => generatePluginContracts({ ...source, components: [{ kind: 'server', plugin }] }),
      /operations|provided/u);
  const components = [...source.components];
  Object.defineProperty(components, 'hidden', { value: 'ignored' });
  assert.throws(() => generatePluginContracts({ ...source, components }), /额外字段/u);
  assert.throws(() => generatePluginContracts({ ...source, description: 'x'.repeat(256 * 1024 + 1) }),
    /上限/u);
  let tooDeep: unknown = { type: 'string' };
  for (let index = 0; index < 45; index++) tooDeep = { type: 'array', items: tooDeep };
  assert.throws(() => generatePluginContracts(schemaManifest(tooDeep)), /深度/u);
});

test('生成的薄调用仅原样转发一次submit，保留原Promise、Job票据、日志和取消信号', async () => {
  const loaded = await moduleSource(generatePluginContracts(manifest()).source);
  const submit = loaded['ExampleWorkspaceNormalizeV1Submit'];
  assert.equal(typeof submit, 'function');
  assert.ok(typeof submit === 'function');
  const signal = new AbortController().signal;
  const input = { message: '只提交一次' };
  const ticket: HostResult<Job> = {
    data: { id: 'queued-job', operation: 'plugin.workspace_suite.server.normalize',
      status: 'queued', result: null, error: null },
    logId: 'original-submit-log',
  };
  let finish: (value: HostResult<Job>) => void = () => {};
  const original = new Promise<HostResult<Job>>((resolvePromise) => { finish = resolvePromise; });
  let calls = 0;
  const server: ServerServiceAccess = {
    list: () => { throw new Error('薄调用不应自行列目录或查询终态'); },
    submit(ref, value, receivedSignal, generation) {
      calls++;
      assert.equal(ref, loaded['ExampleWorkspaceNormalizeV1Ref']);
      assert.equal(value, input);
      assert.equal(receivedSignal, signal);
      assert.equal(generation, 'provider-generation');
      return original;
    },
  };
  const result: unknown = Reflect.apply(submit, undefined, [server, input, signal, 'provider-generation']);
  assert.equal(result, original);
  assert.equal(calls, 1);
  finish(ticket);
  assert.equal(await result, ticket);
  assert.equal(calls, 1);
});

test('薄调用不自动重试同步失败、unknown拒绝或已取消的等待', async () => {
  const loaded = await moduleSource(generatePluginContracts(manifest()).source);
  const submit = loaded['ExampleWorkspaceNormalizeV1Submit'];
  assert.ok(typeof submit === 'function');
  const controller = new AbortController();
  controller.abort('仅取消本次等待');
  let calls = 0;
  const failure = new Error('写入结果未知，保留原始错误和票据');
  const server: ServerServiceAccess = {
    list: () => { throw new Error('不应自行恢复'); },
    submit(_ref, _input, signal, generation) {
      calls++;
      assert.equal(signal, controller.signal);
      assert.equal(signal.aborted, true);
      assert.equal(generation, undefined);
      throw failure;
    },
  };
  assert.throws(() => Reflect.apply(submit, undefined, [server, { message: '一次' }, controller.signal]),
    (error) => error === failure);
  assert.equal(calls, 1);
  const rejection = Promise.reject<HostResult<Job>>(failure);
  server.submit = (_ref, _input, signal) => {
    calls++;
    assert.equal(signal, controller.signal);
    return rejection;
  };
  const result: unknown = Reflect.apply(submit, undefined, [server, { message: '一次' }, controller.signal]);
  assert.equal(result, rejection);
  await assert.rejects(rejection, (error) => error === failure);
  assert.equal(calls, 2);
});

test('生成源码只消费真实发行SDK即可通过独立NodeNext严格类型检查，错误输入与Job误用被拒绝', async () => {
  const frontend = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const root = join(frontend, 'artifacts', '__virtual_contract_consumer__');
  const sdkRoot = join(root, 'node_modules', '@deviceforge', 'plugin-sdk');
  const key = (file: string) => resolve(file).replaceAll('\\', '/').toLowerCase();
  const virtual = new Map<string, string>();
  const put = (file: string, source: string) => virtual.set(key(file), source);
  const issued = await archiveInstalledSdkPackage(frontend, 'sdk', join(frontend, 'artifacts/installed-sdk'));
  const tar = gunzipSync(await readFile(issued.archive));
  for await (const entry of extract()([tar])) {
    assert.ok(entry.header.name.startsWith('package/'));
    const local = entry.header.name.slice('package/'.length);
    assert.equal(local.split('/').some((part) => part === '..'), false);
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    if (local.endsWith('.d.ts') || local === 'package.json')
      put(join(sdkRoot, local), Buffer.concat(chunks).toString('utf8'));
  }
  put(join(root, 'package.json'), '{"type":"module"}');
  const input = {
    type: 'object', required: ['message', 'mode', 'samples', 'settings', 'empty'],
    additionalProperties: false,
    properties: {
      message: { type: ['string', 'null'] },
      mode: { enum: ['compact', 'full'] },
      samples: { type: 'array', items: { type: 'integer' } },
      settings: { type: 'object', additionalProperties: { type: 'boolean' } },
      empty: { type: 'object', additionalProperties: false },
      metadata: { type: 'object', properties: { active: { const: true } } },
    },
  };
  put(join(root, 'generated.ts'), generatePluginContracts(schemaManifest(input)).source);
  const consumer = join(root, 'consumer.ts');
  put(consumer, [
    'import type { HostResult, Job, ServerServiceAccess } from "@deviceforge/plugin-sdk";',
    'import { ExampleWorkspaceNormalizeV1Submit as submit } from "./generated.js";',
    'import type { ExampleWorkspaceNormalizeV1Input as Input, ExampleWorkspaceNormalizeV1Output as Output } from "./generated.js";',
    'declare const server: ServerServiceAccess;',
    'declare const signal: AbortSignal;',
    'const input: Input = { message: null, mode: "compact", samples: [1], settings: { enabled: false }, empty: {}, metadata: { active: true, other: [null, "text"] } };',
    'const output: Output = input;',
    'const receipt: Promise<HostResult<Job>> = submit(server, input, signal, "provider-generation");',
    '// @ts-expect-error 消息仅接受字符串或null。',
    'const badMessage: Input = { ...input, message: 1 };',
    '// @ts-expect-error 枚举不能任意扩大。',
    'const badMode: Input = { ...input, mode: "anything" };',
    '// @ts-expect-error 字典值须符合其明确Schema。',
    'const badDictionary: Input = { ...input, settings: { enabled: "yes" } };',
    '// @ts-expect-error 闭合空对象不能接收额外字段。',
    'const badEmpty: Input = { ...input, empty: { extra: 1 } };',
    '// @ts-expect-error 关闭additionalProperties时拒绝未声明字段。',
    'const badExtra: Input = { ...input, other: true };',
    '// @ts-expect-error 开放JSON字段不能放函数。',
    'const badJson: Input = { ...input, metadata: { handler: () => {} } };',
    '// @ts-expect-error 提交返回Job回执，不是最终业务输出。',
    'const wrongResult: Promise<HostResult<Output>> = submit(server, input, signal);',
    'void [output, receipt, badMessage, badMode, badDictionary, badEmpty, badExtra, badJson, wrongResult];',
  ].join('\n'));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true,
    skipLibCheck: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const originalExists = host.fileExists, originalRead = host.readFile;
  const originalDirectory = host.directoryExists, originalSource = host.getSourceFile;
  const directories = new Set<string>();
  for (const filename of virtual.keys()) {
    let directory = dirname(filename);
    while (directory !== dirname(directory)) {
      directories.add(key(directory));
      directory = dirname(directory);
    }
  }
  host.fileExists = (file) => virtual.has(key(file)) || originalExists(file);
  host.readFile = (file) => virtual.get(key(file)) ?? originalRead(file);
  host.directoryExists = (directory) => directories.has(key(directory)) || originalDirectory?.(directory) === true;
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = virtual.get(key(file));
    return source === undefined
      ? originalSource(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, source, languageVersion);
  };
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram([consumer], options, host);
  const errors = ts.getPreEmitDiagnostics(program);
  const message = ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  });
  assert.equal(errors.length, 0, message);
  assert.ok(program.getSourceFiles().some((file) => key(file.fileName) === key(join(sdkRoot, 'lib/index.d.ts'))));
  assert.equal(program.getSourceFiles().some((file) => key(file.fileName).startsWith(key(join(frontend, 'src')))), false);
});
