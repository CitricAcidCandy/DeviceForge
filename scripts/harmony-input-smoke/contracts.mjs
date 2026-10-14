import assert from 'node:assert/strict';

export const pluginId = 'harmony-device',
  localId = 'HDC001',
  otherId = 'HDC002';
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
export const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export const alias = (name) => (name === 'discover' ? 'harmony.devices' : 'harmony.' + name);
export const operation = (name) => 'plugin.' + pluginId + '.' + name;
export const inputCapability = {
  id: 'input',
  version: 1,
  operation: 'input',
  scope: 'device',
  access: 'write',
  execution_timeout_ms: 30000,
};
const coordinate = { type: 'integer', minimum: 1, maximum: 32767 };
const variant = (kind, properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties: { kind: { const: kind }, ...properties },
  required: ['kind', ...required],
});
export const actionSchema = {
  oneOf: [
    variant('tap', { x: coordinate, y: coordinate }, ['x', 'y']),
    variant(
      'swipe',
      {
        x1: coordinate,
        y1: coordinate,
        x2: coordinate,
        y2: coordinate,
        velocity_pps: { type: 'integer', minimum: 200, maximum: 40000 },
      },
      ['x1', 'y1', 'x2', 'y2'],
    ),
    variant('keyevent', { key_code: { type: 'integer', minimum: 1 } }, ['key_code']),
    variant(
      'text',
      {
        x: coordinate,
        y: coordinate,
        text: { type: 'string', minLength: 1, maxLength: 1024 },
        enter: { type: 'boolean' },
      },
      ['x', 'y', 'text'],
    ),
  ],
};
const serialSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9._:\\[\\]][A-Za-z0-9._:\\[\\]-]*$',
};
export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    device_id: serialSchema,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { action: actionSchema },
      required: ['action'],
    },
  },
  required: ['device_id', 'input'],
};

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
    inputCapability,
  );
  assert.deepEqual(
    manifest.operations.find((entry) => entry.name === 'input').input_schema,
    inputSchema,
  );
  assert.equal(bindings.format_version, 2);
  assert.equal(bindings.bindings.length, 12);
  assert.deepEqual(
    bindings.bindings.map((entry) => entry.operation.id).sort(),
    names.map(alias).sort(),
  );
  const binding = bindings.bindings.find((entry) => entry.operation.id === alias('input'));
  assert.equal(binding.input, 'device_envelope');
  assert.deepEqual(binding.target, {
    kind: 'device_capability',
    plugin_id: pluginId,
    capability: 'input',
    version: 1,
  });
  assert.deepEqual(binding.result, { kind: 'value', wrapped: true });
  assert.deepEqual(binding.operation.input_schema, {
    type: 'object',
    additionalProperties: false,
    properties: { device_id: serialSchema, action: actionSchema },
    required: ['device_id', 'action'],
  });
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
        phase + ' ' + id,
      );
      assert.equal(
        tools.filter((entry) => entry === id).length,
        available ? 1 : 0,
        phase + ' MCP ' + id,
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
    contribution_count: 12,
    definition_capabilities: 11,
    device_availability: 9,
    aliases: names.map(alias),
    operations: names.map(operation),
  });
}
