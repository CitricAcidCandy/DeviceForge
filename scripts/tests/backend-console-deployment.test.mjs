import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join } from 'node:path';
import { defaultDeployment } from '../backend-console/deployment.mjs';
import { deploymentOwnsBinary, ownedListener } from '../backend-console/identities.mjs';

test('普通启动器选择本仓库编译产物，并沿用原有数据与插件目录', () => {
  const root = resolve('deployment-fixture');
  const config = defaultDeployment(root);
  assert.equal(config.binary, join(root, 'backend', 'target', 'debug', 'apk-server.exe'));
  assert.equal(config.dataDirectory, join(root, 'artifacts', 'device-workspace-preview-20261014', 'data'));
  assert.equal(config.pluginDirectory, join(config.directory, 'plugins'));
});

test('正常停止入口仍能核对原固定旧版程序，不接管同端口的其他程序', () => {
  const root = resolve('deployment-fixture');
  const config = defaultDeployment(root);
  const previous = { pid: 123, binary: join(config.directory, 'server-mirroring-release-20261023.exe'), startTime: 'old' };
  assert.equal(deploymentOwnsBinary(config, previous.binary), true, '停止前的第二次身份检查也须接受精确旧程序');
  assert.equal(deploymentOwnsBinary(config, config.binary), true);
  assert.equal(deploymentOwnsBinary(config, join(root, 'other.exe')), false);
  assert.equal(ownedListener(config, { listeners: [previous] }), previous);
  assert.throws(() => ownedListener(config, { listeners: [{ ...previous, binary: join(root, 'other.exe') }] }), /其他进程/);
  assert.throws(() => ownedListener(config, { listeners: [previous, previous] }), /其他进程/);
});
