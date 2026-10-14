import assert from 'node:assert/strict';

export const pluginId = 'harmony-device';
export const names = [
  'discover',
  'packages',
  'connect',
  'disconnect',
  'app.install',
  'app.uninstall',
  'app.detail',
  'app.start',
  'app.stop',
  'app.reset',
  'screenshot',
  'input',
];
export const deviceCapabilities = [
  'packages',
  'app.install',
  'app.uninstall',
  'app.detail',
  'app.start',
  'app.stop',
  'app.reset',
  'screenshot',
  'input',
];
export const localId = 'HDC001',
  otherId = 'HDC002';
export const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export const alias = (name) => (name === 'discover' ? 'harmony.devices' : `harmony.${name}`);
export const operation = (name) => `plugin.${pluginId}.${name}`;
export const screenshotCapability = {
  id: 'screenshot',
  version: 1,
  operation: 'screenshot',
  scope: 'device',
  access: 'write',
  execution_timeout_ms: 30000,
};
export const screenshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    device_id: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      pattern: '^[A-Za-z0-9._:\\[\\]][A-Za-z0-9._:\\[\\]-]*$',
    },
    input: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  required: ['device_id', 'input'],
};
export const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f,
  0, 1, 0xff, 0, 2, 0xff, 0xd9,
]);

export function assertSourceContract(manifest, example, bindings) {
  assert.deepEqual(manifest, example);
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 4);
  assert.equal(manifest.devices.api_version, 3);
  assert.equal(manifest.devices.platform, 'harmony');
  assert.equal(manifest.devices.discover_operation, 'discover');
  assert.deepEqual(manifest.args, []);
  assert.deepEqual(manifest.artifacts, {
    input_fields: [],
    input_pointers: ['/input/artifact_id'],
    outputs: true,
  });
  assert.deepEqual(manifest.operations.map((entry) => entry.name).sort(), [...names].sort());
  assert.equal(manifest.devices.capabilities.length, 11);
  assert.deepEqual(
    manifest.devices.capabilities.find((entry) => entry.id === 'input'),
    {
      id: 'input',
      version: 1,
      operation: 'input',
      scope: 'device',
      access: 'write',
      execution_timeout_ms: 30000,
    },
  );
  assert.deepEqual(
    manifest.devices.capabilities.find((entry) => entry.id === 'screenshot'),
    screenshotCapability,
  );
  assert.deepEqual(
    manifest.operations.find((entry) => entry.name === 'screenshot').input_schema,
    screenshotSchema,
  );
  assert.equal(bindings.format_version, 2);
  assert.equal(bindings.bindings.length, names.length);
  assert.deepEqual(
    bindings.bindings.map((entry) => entry.operation.id).sort(),
    names.map(alias).sort(),
  );
  const binding = bindings.bindings.find((entry) => entry.operation.id === alias('screenshot'));
  assert.equal(binding.input, 'device_envelope');
  assert.deepEqual(binding.target, {
    kind: 'device_capability',
    plugin_id: pluginId,
    capability: 'screenshot',
    version: 1,
  });
  assert.deepEqual(binding.result, { kind: 'value', wrapped: false });
  assert.deepEqual(binding.operation.input_schema, {
    type: 'object',
    additionalProperties: false,
    properties: { device_id: screenshotSchema.properties.device_id },
    required: ['device_id'],
  });
}

export function assertScreenshotResult(value, expectedBytes = jpeg.length) {
  assert.deepEqual(Object.keys(value).sort(), ['artifacts', 'result']);
  assert.equal(value.result, null);
  assert.ok(Array.isArray(value.artifacts));
  assert.equal(value.artifacts.length, 1);
  const artifact = value.artifacts[0];
  assert.match(artifact.id, uuid);
  assert.deepEqual(Object.keys(artifact).sort(), [
    'created_at',
    'filename',
    'id',
    'media_type',
    'sha256',
    'size',
  ]);
  assert.equal(artifact.filename, 'screenshot.jpeg');
  assert.equal(artifact.media_type, 'image/jpeg');
  assert.ok(Number.isSafeInteger(artifact.created_at) && artifact.created_at > 0);
  assert.equal(artifact.size, expectedBytes);
  assert.match(artifact.sha256, /^[a-f\d]{64}$/);
  return artifact;
}

export async function catalog(host, deployment, report, phase, available, owner) {
  const operations = await host.client.json('/api/v2/operations');
  assert.deepEqual(await host.client.tool('deviceforge.list_operations'), operations);
  const tools = await host.client.tools();
  for (const name of names)
    for (const id of [alias(name), operation(name)]) {
      assert.equal(
        operations.filter((entry) => entry.id === id).length,
        available ? 1 : 0,
        `${phase} ${id}`,
      );
      assert.equal(
        tools.filter((entry) => entry === id).length,
        available ? 1 : 0,
        `${phase} MCP ${id}`,
      );
    }
  const providers = await host.client.json('/api/v2/device-providers');
  assert.deepEqual(await host.client.tool('deviceforge.list_device_providers'), providers);
  const ours = providers.filter((entry) => entry.id === pluginId);
  assert.equal(ours.length, available ? 1 : 0);
  if (available) {
    assert.equal(ours[0].generation, owner.generation);
    assert.equal(ours[0].version, deployment.manifest.version);
    assert.deepEqual(ours[0].definition, {
      ...deployment.manifest.devices,
      discover_operation: operation('discover'),
      capabilities: deployment.manifest.devices.capabilities.map((entry) => ({
        ...entry,
        operation: operation(entry.operation),
      })),
    });
    report.provider = ours[0];
  }
  assert.deepEqual(
    await host.client.tool('deviceforge.list_devices'),
    await host.client.json('/api/v2/devices'),
  );
  report.catalog_phases ??= [];
  report.catalog_phases.push({
    phase,
    available,
    contribution_count: names.length,
    definition_capabilities: 11,
    device_availability: 9,
    aliases: names.map(alias),
    operations: names.map(operation),
  });
}
