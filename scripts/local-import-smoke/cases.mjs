// 真实任务与磁盘原字节共同证明导入结果；夹具只包含文本与自包含插件代码。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  digest,
  pluginArchives,
  sections,
  settingsOwner,
  toolArchive,
  toolBytes,
  toolCatalog,
  toolId,
} from './fixtures.mjs';

const owner = { scope: 'user', owner_id: settingsOwner };
const addCheck = (report, name) => report.checks.push(name);
const toolPath = (data) => join(data, 'tools', toolId, 'entry.txt');
const statePath = (data) => join(data, 'tools', toolId, '.tool-supply-state.json');

export async function importTools(api, data, report) {
  const archive = toolArchive();
  const uploaded = await api.upload(archive, 'local-tools.zip');
  assert.equal(uploaded.size, archive.length);
  assert.equal(uploaded.sha256, digest(archive));
  const manifest = toolCatalog(archive);
  const input = { archive_artifact_id: uploaded.id, module_id: toolId, manifest };
  const result = await api.job('plugin.tool-supply.import', input);
  assert.deepEqual(result, {
    module_id: toolId,
    version: '1.0.0',
    sha256: digest(archive),
    changed: true,
  });
  assert.deepEqual(await readFile(toolPath(data)), toolBytes);
  const state = await readFile(statePath(data));
  assert.equal(JSON.parse(state).manifest_version, manifest.manifestVersion);
  addCheck(report, 'HTTP 上传真实 ZIP 并离线导入至数据根下 tools');
  const repeated = await api.job('plugin.tool-supply.import', input, 'mcp');
  assert.equal(repeated.changed, false);
  assert.deepEqual(await readFile(statePath(data)), state);
  addCheck(report, 'MCP 重复导入保持版本、内容和安装时间不变');
  const invalid = structuredClone(input);
  invalid.manifest.modules[0].version = '1.1.0';
  invalid.manifest.modules[0].sha256 = '0'.repeat(64);
  const failed = await api.job('plugin.tool-supply.import', invalid, 'mcp', 'failed');
  assert.match(failed.error, /SHA-256/);
  assert.deepEqual(await readFile(toolPath(data)), toolBytes);
  assert.deepEqual(await readFile(statePath(data)), state);
  await assert.rejects(readFile(join(data, 'missing-catalog.json')), { code: 'ENOENT' });
  addCheck(report, 'MCP 摘要失败后原工具与状态原字节保留，不读取部署清单');
  report.persisted.tool = { entry_sha256: digest(toolBytes), state_sha256: digest(state) };
}

export async function importSettings(api, data, report) {
  const initial = await api.job('plugin.settings.list', owner);
  assert.equal(initial.revision, '0');
  const imported = await api.job(
    'plugin.settings.import',
    { ...owner, sections, expected_revision: '0' },
    'mcp',
  );
  assert.equal(imported.revision, '1');
  assert.deepEqual(imported.sections, sections);
  const path = join(data, 'settings', 'users', settingsOwner, 'settings.json');
  const bytes = await readFile(path);
  const conflict = await api.job(
    'plugin.settings.import',
    { ...owner, sections: { deviceInfo: { overwritten: true } }, expected_revision: '0' },
    'http',
    'failed',
  );
  assert.match(conflict.error, /修订冲突/);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual((await api.job('plugin.settings.list', owner)).sections, sections);
  addCheck(report, 'MCP 配置导入提交修订，HTTP 过期 CAS 保留原内容');
  report.persisted.settings = { revision: '1', file_sha256: digest(bytes) };
}

export async function installPackages(api, data, report) {
  const installed = [];
  for (const fixture of pluginArchives()) {
    const result = await api.api(`/api/v2/plugin-packages/${fixture.kind}?format=zip`, {
      method: 'POST',
      type: 'application/zip',
      bytes: fixture.archive,
      status: 201,
    });
    assert.equal(result.id, fixture.id);
    assert.equal(result.kind, fixture.kind);
    assert.ok(
      (await api.api(`/api/v2/plugin-packages/${fixture.kind}`)).some(
        (item) => item.id === fixture.id,
      ),
    );
    const directory = join(
      data,
      fixture.kind === 'browser' ? 'browser-plugins' : 'plugins',
      fixture.id,
    );
    await assert.rejects(readFile(join(directory, 'INSTALL_SCRIPT_RAN')), { code: 'ENOENT' });
    if (fixture.kind === 'server') {
      await assert.rejects(readFile(join(directory, 'ENTRY_RAN')), { code: 'ENOENT' });
    } else {
      await api.asset(result.entry_url, fixture.module);
    }
    installed.push({
      id: fixture.id,
      kind: fixture.kind,
      archive_sha256: digest(fixture.archive),
      install_did_not_execute_code: true,
      browser_module_executed: false,
    });
  }
  report.persisted.packages = installed;
  addCheck(report, '浏览器与服务器 ZIP 包经真实上传安装，安装阶段不运行包脚本或入口');
}

export async function verifyRestart(api, data, report) {
  assert.deepEqual(await readFile(toolPath(data)), toolBytes);
  assert.equal(digest(await readFile(statePath(data))), report.persisted.tool.state_sha256);
  const settings = await api.job('plugin.settings.list', owner, 'mcp');
  assert.equal(settings.revision, report.persisted.settings.revision);
  assert.deepEqual(settings.sections, sections);
  assert.equal(
    digest(await readFile(join(data, 'settings', 'users', settingsOwner, 'settings.json'))),
    report.persisted.settings.file_sha256,
  );
  addCheck(report, '退出重启后工具原字节、安装状态、配置修订与配置内容保持一致');
  for (const fixture of pluginArchives()) {
    const packages = await api.api(`/api/v2/plugin-packages/${fixture.kind}`);
    const current = packages.find((item) => item.id === fixture.id);
    assert.ok(current, '已导入插件包应在重启后继续列出');
    if (fixture.kind === 'browser') {
      await api.asset(current.entry_url, fixture.module);
    } else {
      assert.ok((await api.api('/api/v2/plugins')).some((item) => item.id === fixture.id));
      const echo = { message: '重启后执行自包含回显夹具', value: 7 };
      assert.deepEqual(
        await api.job(`plugin.${fixture.id}.echo`, echo, 'mcp', 'succeeded', 'legacy_json'),
        echo,
      );
    }
  }
  addCheck(report, '重启保留两类插件包，浏览器模块原字节可取且服务器夹具可通过 MCP 执行');
}
