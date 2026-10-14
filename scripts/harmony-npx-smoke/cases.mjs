import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog } from '../harmony-device-smoke/bootstrap.mjs';
import { discover } from '../harmony-device-smoke/discovery.mjs';
import { action, submitAction } from '../harmony-device-smoke/actions.mjs';
import { applicationCase } from '../harmony-device-smoke/applications.mjs';
import { detailEntry } from '../harmony-device-smoke/details.mjs';
import { emptyScratch, installationCopy, upload } from '../harmony-device-smoke/artifacts.mjs';
import {
  finishedTool,
  keys,
  localId,
  observations,
  setMode,
} from '../harmony-device-smoke/fixtures.mjs';
import { jobList, preserveHistory, record } from '../harmony-device-smoke/jobs.mjs';
import { names, operation, pluginId } from '../harmony-device-smoke/deployment.mjs';
import { networkEntry } from '../harmony-device-smoke/network.mjs';

async function capability(host, fixture, report, name, transport, phase) {
  const input =
    name === 'packages'
      ? {}
      : name === 'app.install'
        ? { artifact_id: fixture.installSource.id }
        : { package: 'com.smoke.harmony' };
  const beforeJobs = await jobList(host),
    beforeTools = await keys(fixture);
  const entry = await submitAction(
    host,
    report,
    `${phase}-${name}-${transport}`,
    action(report.provider, name, localId, input),
    transport,
  );
  const job = await record(host, entry),
    previous = new Set(beforeJobs.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !previous.has(item.id)).map((item) => item.id),
    [entry.job_id],
  );
  const added = (await observations(fixture)).filter(
    (item) => !beforeTools.includes(item.directory),
  );
  assert.equal(added.length, 1);
  entry.tool = await finishedTool(added[0]);
  let result;
  if (name === 'app.install') {
    await installationCopy(fixture, entry.tool);
    await emptyScratch(fixture);
    result = {
      artifact_id: fixture.installSource.id,
      output: `Installed ${fixture.installSource.filename}\nmsg:install bundle successfully.`,
    };
    assert.ok(!JSON.stringify(job.result).includes(entry.tool.ready.argv[3]));
  } else {
    assert.deepEqual(
      entry.tool.ready.argv,
      name === 'packages'
        ? ['-t', localId, 'shell', 'bm', 'dump', '-a']
        : ['-t', localId, 'uninstall', input.package],
    );
    result = {
      output:
        name === 'packages' ? 'com.alpha.app\ncom.beta.app' : 'msg:uninstall bundle successfully.',
    };
  }
  assert.deepEqual(job.result, { result, artifacts: [] });
  assert.equal(job.error, null);
  return entry;
}

export async function phaseCases(host, deployment, fixture, report, phase) {
  const owners = await host.client.json('/api/v2/plugins');
  assert.deepEqual(await host.client.tool('deviceforge.list_plugins'), owners);
  assert.equal(owners.length, 1);
  const owner = owners[0];
  assert.equal(owner.id, pluginId);
  assert.equal(owner.state, 'loaded');
  assert.equal(owner.cleanup_failed, false);
  phase.generation = owner.generation;
  if (report.phases.length > 1) assert.notEqual(owner.generation, report.phases[0].generation);
  await catalog(host, deployment, report, phase.phase, true, owner);
  const operations = await host.client.json('/api/v2/operations');
  assert.deepEqual(
    operations
      .filter((item) => item.id.startsWith(`plugin.${pluginId}.`))
      .map((item) => item.id)
      .sort(),
    names.map(operation).sort(),
  );
  assert.deepEqual(await keys(fixture), phase.tools_before);
  const beforeJobs = await jobList(host),
    previous = new Set(beforeJobs.map((item) => item.id)),
    start = report.jobs.length;
  assert.deepEqual(await host.client.json('/api/v2/devices'), []);
  for (const name of ['connect', 'disconnect'])
    for (const transport of ['http', 'mcp']) {
      await networkEntry(host, fixture, report, {
        caseId: `${phase.phase}-${name}-${transport}`,
        name,
        point: 'capability',
        transport,
        mode: name === 'connect' && transport === 'mcp' ? 'network-repeat' : 'normal',
        expected:
          name === 'connect' && transport === 'mcp'
            ? '[Info]Target is connected, repeat operation'
            : undefined,
      });
      assert.deepEqual(await host.client.json('/api/v2/devices'), []);
    }
  await discover(host, deployment, fixture, report, {
    entry: 'direct',
    transport: 'http',
    phase: phase.phase,
  });
  await discover(host, deployment, fixture, report, {
    entry: 'alias',
    transport: 'mcp',
    phase: phase.phase,
  });
  await upload(host, fixture, report);
  for (const name of ['packages', 'app.install', 'app.uninstall'])
    for (const transport of ['http', 'mcp']) {
      await capability(host, fixture, report, name, transport, phase.phase);
    }
  for (const name of ['app.start', 'app.stop', 'app.reset'])
    for (const transport of ['http', 'mcp']) {
      await applicationCase(host, fixture, report, {
        caseId: `${phase.phase}-${name}-${transport}`,
        name,
        point: 'capability',
        transport,
      });
    }
  for (const transport of ['http', 'mcp'])
    await applicationCase(host, fixture, report, {
      caseId: `${phase.phase}-自动ability-${transport}`,
      name: 'app.start',
      point: 'capability',
      transport,
      automatic: true,
    });
  await detailEntry(host, fixture, report, {
    caseId: `${phase.phase}-详情-capability-http`,
    point: 'capability',
    transport: 'http',
    mode: 'detail-full',
    expected: {
      name: 'com.smoke.harmony',
      versionCode: 7,
      custom: { enabled: true, text: 'ordinary failed text' },
      metadata: [1, 'two', null],
      hapModuleInfos: [{ bundleName: 'other.app', mainElementName: 'Entry' }, null],
    },
  });
  await detailEntry(host, fixture, report, {
    caseId: `${phase.phase}-详情-alias-mcp`,
    point: 'alias',
    transport: 'mcp',
    mode: 'detail-no-entry',
    expected: { name: 'com.smoke.harmony', status: 'installed', custom: [true, 7] },
  });
  await setMode(fixture, 'normal');
  const jobs = report.jobs.slice(start),
    tools = jobs.flatMap((entry) => entry.tools ?? (entry.tool ? [entry.tool] : []));
  assert.equal(jobs.length, 22);
  assert.equal(tools.length, 24);
  assert.equal(new Set(jobs.map((item) => item.job_id)).size, 22);
  assert.deepEqual(
    (await jobList(host))
      .filter((item) => !previous.has(item.id))
      .map((item) => item.id)
      .sort(),
    jobs.map((item) => item.job_id).sort(),
  );
  const observed = (await observations(fixture)).filter(
    (item) => !phase.tools_before.includes(item.directory),
  );
  assert.deepEqual(
    tools.map((item) => item.directory).sort(),
    observed.map((item) => item.directory).sort(),
  );
  assert.equal(new Set(tools.map((item) => item.directory)).size, 24);
  assert.equal(jobs.filter((item) => item.tools?.length === 2).length, 2);
  phase.inventory = {
    job_ids: jobs.map((item) => item.job_id),
    jobs: 22,
    tools: 24,
    capabilities: report.provider.definition.capabilities.map((item) => item.id),
    automatic_start_jobs: 2,
  };
  await preserveHistory(host, report, phase.phase + '全部历史');
  await emptyScratch(fixture);
  const uploadedBytes = await readFile(
    join(
      jobs.find((item) => item.operation === operation('app.install')).tool.directory,
      'install-input.bin',
    ),
  );
  assert.deepEqual(uploadedBytes, fixture.installBytes);
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  report.checks.push({
    name:
      phase.phase +
      '十贡献/九定义能力、两协议22Job/24HDC、无发现provider动作/详情/自动ability/HAP原字节及历史',
    passed: true,
  });
}
