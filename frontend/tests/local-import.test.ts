import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { ApiError } from '../src/services/api/index.ts';
import type { PluginConfigurationView } from '../src/features/plugin-configurations/index.ts';
import { createToolSupply } from '../src/features/tool-supply/index.ts';
import type { JobOutcome, JsonData } from '../src/shared/jobs/index.ts';
import {
  previewLocalImport,
  submitLocalImport,
} from '../src/pages/marketplace/local-import/actions.ts';
import type { LocalImportPorts } from '../src/pages/marketplace/local-import/actions.ts';
import {
  digestLocalFile,
  parseLocalConfiguration,
  parseLocalToolManifest,
} from '../src/pages/marketplace/local-import/rules.ts';
import { prepareUpload } from '../src/pages/marketplace/upload-preparation/prepare.ts';
import { plugin, signal } from './fixtures.ts';

const artifactId = '4f8f8ef4-753f-45a3-9984-936d615fecea';
const unused = async (): Promise<never> => {
  throw new Error('不应调用其他导入端口');
};
function ports(): LocalImportPorts {
  return {
    packages: { upload: unused },
    serverPlugins: { refresh: unused },
    artifacts: { upload: unused },
    tools: { importLocal: unused },
    settings: { list: unused, import: unused },
    configurations: { get: unused, save: unused },
  };
}
function outcome<T>(data: T): JobOutcome<T> {
  return {
    data,
    job: {
      id: 'local-import-job',
      operation: 'plugin.settings.list',
      status: 'succeeded',
      error: null,
      result: null,
    },
    logId: 'local-log',
    submitLogId: 'submit-log',
  };
}
function configuration(): PluginConfigurationView {
  return {
    kind: 'server',
    id: 'example',
    definition: {
      version: 1,
      schema: { type: 'object', properties: { count: { type: 'integer' } } },
      defaults: { count: 1 },
      apply_policy: 'plugin_reload',
    },
    values: { count: 1 },
    revision: '7',
    appliedRevision: '7',
    pendingReload: false,
    compatible: true,
    fieldErrors: [],
    source: 'managed',
  };
}
function configFile(value: unknown) {
  return new File([JSON.stringify(value)], 'config.json', { type: 'application/json' });
}

test('本地配置只接受明确目标的规范封装，不接受根启动配置或服务器路径', () => {
  assert.deepEqual(
    parseLocalConfiguration({
      format_version: 1,
      kind: 'settings',
      scope: 'user',
      owner_id: 'local',
      sections: { editor: { theme: 'dark' } },
    }),
    { kind: 'settings', scope: 'user', owner_id: 'local', sections: { editor: { theme: 'dark' } } },
  );
  for (const value of [
    { sections: { editor: {} } },
    { format_version: 1, server: { port: 23333 } },
    {
      format_version: 1,
      kind: 'settings',
      scope: 'user',
      owner_id: 'local',
      sections: {},
      path: 'C:/config.json',
    },
    { format_version: 1, kind: 'server_plugin_configuration', plugin_id: '../plugin', values: {} },
  ])
    assert.throws(() => parseLocalConfiguration(value));
});

test('设置导入沿用预览修订，期间修改触发CAS冲突且不会读取新修订覆盖', async () => {
  let lists = 0;
  const seen: string[] = [];
  const dependencies: LocalImportPorts = {
    ...ports(),
    settings: {
      list: async () => {
        lists++;
        return outcome({ format_version: 1, revision: '3', sections: {} });
      },
      import: async (input) => {
        seen.push(input.expected_revision);
        throw new ApiError('http', 'revision_conflict', '配置已变化', 409, 'conflict-log');
      },
    },
  };
  const preview = await previewLocalImport(
    dependencies,
    {
      kind: 'config',
      file: configFile({
        format_version: 1,
        kind: 'settings',
        scope: 'workspace',
        owner_id: 'team',
        sections: { editor: { mode: 'dark' } },
      }),
      manifest: null,
      moduleId: '',
    },
    signal(),
  );
  assert.match(preview.target, /team/);
  assert.equal(preview.kind === 'config' && preview.revision, '3');
  await assert.rejects(
    submitLocalImport(dependencies, preview, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'conflict-log',
  );
  assert.equal(lists, 1);
  assert.deepEqual(seen, ['3']);
});

test('服务器插件配置要求已安装目标，固定预览修订保存但不自动应用', async () => {
  let saved = 0;
  const dependencies: LocalImportPorts = {
    ...ports(),
    serverPlugins: { refresh: async () => ({ data: [plugin()], logId: null }) },
    configurations: {
      get: async () => configuration(),
      save: async (target, revision, values) => {
        saved++;
        assert.deepEqual(target, { kind: 'server', id: 'example' });
        assert.equal(revision, '7');
        assert.deepEqual(values, { count: 2 });
        return { ...configuration(), revision: '8', pendingReload: true };
      },
    },
  };
  const input = {
    kind: 'config',
    file: configFile({
      format_version: 1,
      kind: 'server_plugin_configuration',
      plugin_id: 'example',
      values: { count: 2 },
    }),
    manifest: null,
    moduleId: '',
  } satisfies Parameters<typeof previewLocalImport>[1];
  const preview = await previewLocalImport(dependencies, input, signal());
  assert.match(await submitLocalImport(dependencies, preview, signal()), /显式应用/);
  assert.equal(saved, 1);
  await assert.rejects(
    previewLocalImport(
      { ...dependencies, serverPlugins: { refresh: async () => ({ data: [], logId: null }) } },
      input,
      signal(),
    ),
    /尚未安装/,
  );
  await assert.rejects(
    previewLocalImport(
      {
        ...dependencies,
        configurations: {
          ...dependencies.configurations,
          get: async () => ({ ...configuration(), compatible: false }),
        },
      },
      input,
      signal(),
    ),
    /不兼容/,
  );
  const readonly: LocalImportPorts = {
    ...dependencies,
    configurations: {
      ...dependencies.configurations,
      get: async () => ({
        ...configuration(),
        values: { count: 1, fixed: 'constant' },
        definition: {
          version: 1,
          schema: {
            type: 'object',
            properties: { count: { type: 'integer' }, fixed: { type: 'string', readOnly: true } },
          },
          defaults: { count: 1, fixed: 'constant' },
          apply_policy: 'plugin_reload',
        },
      }),
    },
  };
  await previewLocalImport(readonly, input, signal());
  await assert.rejects(
    previewLocalImport(
      readonly,
      {
        ...input,
        file: configFile({
          format_version: 1,
          kind: 'server_plugin_configuration',
          plugin_id: 'example',
          values: { fixed: 'changed' },
        }),
      },
      signal(),
    ),
    /只读字段/,
  );
});

test('本地工具核对选中ZIP的大小和摘要，产物异常停止提交且不调用市场', async () => {
  const file = new File(['local tool bytes'], 'tool.zip');
  const sha256 = await digestLocalFile(file, signal());
  const raw = {
    manifestVersion: 'local-v1',
    modules: [
      {
        name: 'first',
        version: '1.0',
        url: 'https://example.test/tool.zip',
        size: file.size,
        sha256,
      },
      {
        name: 'second',
        version: '2.0',
        url: 'https://example.test/tool.zip',
        size: file.size + 1,
        sha256,
      },
    ],
  };
  const manifest = parseLocalToolManifest(raw);
  let imports = 0;
  let uploaded = 0;
  const dependencies: LocalImportPorts = {
    ...ports(),
    artifacts: {
      upload: async (name, content) => {
        uploaded++;
        assert.equal(name, file.name);
        assert.equal(content, file);
        return {
          data: {
            id: artifactId,
            filename: name,
            media_type: 'application/zip',
            size: file.size,
            sha256,
            created_at: 1,
          },
          logId: null,
        };
      },
    },
    tools: {
      importLocal: async (input) => {
        imports++;
        assert.equal(input.archive_artifact_id, artifactId);
        assert.equal(input.module_id, 'first');
        assert.deepEqual(input.manifest, raw);
        return outcome({ module_id: 'first', version: '1.0', sha256, changed: true });
      },
    },
  };
  const input = { kind: 'tool', file, manifest, moduleId: 'first' } satisfies Parameters<
    typeof previewLocalImport
  >[1];
  await assert.rejects(
    previewLocalImport(dependencies, { ...input, moduleId: 'second' }, signal()),
    /大小/,
  );
  const preview = await previewLocalImport(dependencies, input, signal());
  assert.match(await submitLocalImport(dependencies, preview, signal()), /未执行工具/);
  assert.equal(imports, 1);
  assert.equal(uploaded, 1);
  await assert.rejects(
    submitLocalImport(
      {
        ...dependencies,
        artifacts: {
          upload: async () => ({
            data: {
              id: artifactId,
              filename: file.name,
              media_type: 'application/zip',
              size: file.size,
              sha256: '0'.repeat(64),
              created_at: 1,
            },
            logId: null,
          }),
        },
      },
      preview,
      signal(),
    ),
    /产物摘要/,
  );
  assert.equal(imports, 1);
  await assert.rejects(
    previewLocalImport(
      dependencies,
      {
        ...input,
        manifest: parseLocalToolManifest({
          ...raw,
          modules: [{ ...raw.modules[0], sha256: '0'.repeat(64) }],
        }),
      },
      signal(),
    ),
    /SHA-256/,
  );
});

test('本地插件原ZIP经清单校验后直接安装，不修改包或自动启用', async () => {
  const bytes = zipSync({
    'package.json': strToU8(
      JSON.stringify({
        version: '1.0',
        deviceforge: {
          kind: 'browser',
          manifest: 'plugin.json',
          entrypoints: { browser: { path: 'dist/index.js' } },
        },
      }),
    ),
    'plugin.json': strToU8(JSON.stringify({ id: 'local.plugin', version: '1.0' })),
    'dist/index.js': strToU8('export const plugin = {};'),
  });
  const file = new File([new Uint8Array(bytes).buffer], 'plugin.zip');
  const calls: string[] = [];
  const dependencies: LocalImportPorts = {
    ...ports(),
    packages: {
      upload: async (kind, content, mediaType, _signal, expected) => {
        calls.push('upload');
        assert.equal(kind, 'browser');
        assert.equal(content, file);
        assert.equal(mediaType, 'application/zip');
        assert.deepEqual(expected, { id: 'local.plugin', version: '1.0', kind: 'browser' });
        return {
          data: {
            id: 'local.plugin',
            kind,
            version: '1.0',
            runtime: 'browser',
            entry_path: 'dist/index.js',
            api_version: 2,
            installed_at: 1,
          },
          logId: null,
        };
      },
    },
  };
  const preview = await previewLocalImport(
    dependencies,
    { kind: 'plugin', file, manifest: null, moduleId: '' },
    signal(),
    async (request) => prepareUpload(request),
  );
  assert.match(await submitLocalImport(dependencies, preview, signal()), /尚未自动启用/);
  assert.deepEqual(calls, ['upload']);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(submitLocalImport(dependencies, preview, aborted.signal));
  assert.equal(calls.length, 1);
});

test('工具本地导入使用独立操作与四字段结果，恢复不重提并保留日志', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const data = { module_id: 'localtool', version: '1.0', sha256: 'a'.repeat(64), changed: false };
  const tools = createToolSupply({
    submit: async (operation, input) => {
      seen.push({ operation, input });
      return {
        data: {
          id: 'import-job',
          operation,
          status: 'succeeded',
          error: null,
          result: { result: data, artifacts: [] },
        },
        logId: 'import-log',
      };
    },
    getJob: async () => ({
      data: {
        id: 'import-job',
        operation: 'plugin.tool-supply.import',
        status: 'succeeded',
        error: null,
        result: { result: data, artifacts: [] },
      },
      logId: 'resume-log',
    }),
    cancelJob: unused,
  });
  try {
    assert.throws(
      () =>
        tools.importLocal(
          { archive_artifact_id: '../tool.zip', module_id: 'localtool', manifest: {} },
          signal(),
        ),
      ApiError,
    );
    const result = await tools.importLocal(
      { archive_artifact_id: artifactId, module_id: 'localtool', manifest: { modules: [] } },
      signal(),
    );
    assert.equal(result.data.changed, false);
    assert.equal(result.logId, 'import-log');
    assert.equal(seen[0]?.operation, 'plugin.tool-supply.import');
    const resumed = await tools.resumeImport(
      { id: 'import-job', operation: 'plugin.tool-supply.import', submitLogId: 'import-log' },
      'localtool',
      signal(),
    );
    assert.equal(resumed.logId, 'resume-log');
    assert.equal(seen.length, 1);
    await assert.rejects(
      tools.resumeImport(
        { id: 'import-job', operation: 'plugin.tool-supply.import', submitLogId: null },
        'other',
        signal(),
      ),
      ApiError,
    );
  } finally {
    tools.dispose();
  }
});
