import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/services/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import {
  convertLegacyFiles,
  createSettings,
  parseLegacyEditorText,
} from '../src/features/settings/index.ts';
import { signal } from './fixtures.ts';

const owner: { scope: 'user'; owner_id: string; expected_revision: string } = {
  scope: 'user',
  owner_id: 'legacy-owner',
  expected_revision: '3',
};

test('旧七文件映射保留配置区拼写、未知业务字段及 JSON 原值', () => {
  const files = [
    { name: 'deviceInfo.json', text: '{"extra":{"unknown":true},"items":[]}' },
    { name: 'packageInfo.json', text: 'null' },
    { name: 'iframePageUrl.json', text: '"https://example.invalid/page"' },
    { name: 'permissions.json', text: '["one","two"]' },
    { name: 'luaCommand.json', text: JSON.stringify('{"nested":true}') },
    { name: 'dynamicSnalysisHooks.json', text: '{"enabled":false}' },
    { name: 'packageSdk.json', text: '{"__proto__":{"retained":true},"sdk":42}' },
  ];
  const sections = convertLegacyFiles(files);
  assert.deepEqual(Object.keys(sections), [
    'deviceInfo',
    'packageInfo',
    'iframePageUrl',
    'permissions',
    'luaCommand',
    'dynamicSnalysisHooks',
    'packageSDK',
  ]);
  assert.deepEqual(sections.deviceInfo, { extra: { unknown: true }, items: [] });
  assert.equal(sections.packageInfo, null);
  assert.equal(sections.luaCommand, '{"nested":true}');
  assert.deepEqual(sections.permissions, ['one', 'two']);
  assert.deepEqual(sections.packageSDK, JSON.parse('{"__proto__":{"retained":true},"sdk":42}'));
  assert.equal(Object.hasOwn(sections, 'packageSdk'), false);
});

test('旧文本入口解析一次，保留字符串和 null，拒绝非有限数值且不泄漏正文', () => {
  assert.equal(parseLegacyEditorText('null'), null);
  assert.equal(
    parseLegacyEditorText(JSON.stringify('{"notParsedAgain":true}')),
    '{"notParsedAgain":true}',
  );
  for (const text of ['1e999', '{"secret":"unfinished', '[1,]']) {
    assert.throws(
      () => parseLegacyEditorText(text),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'invalid_legacy_settings' &&
        !error.message.includes('secret'),
    );
  }
});

test('未知、路径、重复、空批次及非法文本整批拒绝', () => {
  for (const files of [
    [],
    [{ name: 'unknown.json', text: '{}' }],
    [{ name: '../deviceInfo.json', text: '{}' }],
    [{ name: 'packageSDK.json', text: '{}' }],
    [
      { name: 'deviceInfo.json', text: '{}' },
      { name: 'deviceInfo.json', text: '{}' },
    ],
    [
      { name: 'deviceInfo.json', text: '{}' },
      { name: 'packageInfo.json', text: 'not-json-secret' },
    ],
  ]) {
    assert.throws(
      () => convertLegacyFiles(files),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'invalid_legacy_settings' &&
        !error.message.includes('not-json-secret'),
    );
  }
});

function gateway(calls: { operation: string; input: JsonData; signal: AbortSignal }[]): JobGateway {
  return {
    submit: async (operation, input, abort) => {
      calls.push({ operation, input, signal: abort });
      return {
        data: {
          id: 'legacy-job',
          operation,
          status: 'succeeded',
          result: {
            result: { format_version: 1, revision: '4', sections: { deviceInfo: null } },
            artifacts: [],
          },
          error: null,
        },
        logId: 'legacy-log',
      };
    },
    getJob: async () => {
      throw new Error('不应增加读取或重放');
    },
    cancelJob: async () => {
      throw new Error('不应隐式取消');
    },
  };
}

test('转换失败、归属或 CAS 无效时零提交', () => {
  const calls: { operation: string; input: JsonData; signal: AbortSignal }[] = [];
  const settings = createSettings(gateway(calls));
  const files = [{ name: 'deviceInfo.json', text: 'null' }];
  assert.throws(
    () =>
      settings.importLegacy(
        { ...owner, files: [...files, { name: 'packageInfo.json', text: 'invalid' }] },
        signal(),
      ),
    ApiError,
  );
  assert.throws(
    () => settings.importLegacy({ ...owner, owner_id: '../owner', files }, signal()),
    ApiError,
  );
  assert.throws(
    () => settings.importLegacy({ ...owner, expected_revision: '03', files }, signal()),
    ApiError,
  );
  const extra = { ...owner, files, path: 'ignored-path' };
  assert.throws(() => settings.importLegacy(extra, signal()), ApiError);
  assert.equal(calls.length, 0);
  settings.dispose();
});

test('旧文件导入只提交一次现有操作，沿用修订、信号和真实日志', async () => {
  const calls: { operation: string; input: JsonData; signal: AbortSignal }[] = [];
  const settings = createSettings(gateway(calls));
  const abort = new AbortController();
  const result = await settings.importLegacy(
    { ...owner, files: [{ name: 'deviceInfo.json', text: 'null' }] },
    abort.signal,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.input, { ...owner, sections: { deviceInfo: null } });
  assert.equal(calls[0]?.operation, 'plugin.settings.import');
  assert.equal(calls[0]?.signal.aborted, false);
  abort.abort();
  assert.equal(calls[0]?.signal.aborted, true);
  assert.equal(result.logId, 'legacy-log');
  assert.equal(result.data.revision, '4');
  settings.dispose();
});

test('普通 JSON 字符串写入不因旧文本兼容入口而改变', async () => {
  const calls: { operation: string; input: JsonData; signal: AbortSignal }[] = [];
  const settings = createSettings(gateway(calls));
  const text = '{"stringValue":true}';
  await settings.set({ ...owner, section: 'deviceInfo', value: text }, signal());
  assert.deepEqual(calls[0]?.input, { ...owner, section: 'deviceInfo', value: text });
  settings.dispose();
});
