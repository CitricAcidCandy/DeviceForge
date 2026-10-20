import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSchemaFields, mapSchemaSecrets, readonlyIssues, redactSchemaDefaults } from '../src/utils/schema.ts';
import type { SchemaValue } from '../src/utils/schema.ts';

const schema: SchemaValue = {
  type: 'object',
  $defs: {
    token: { type: 'string', writeOnly: true, default: 'token-default' },
    fixed: { type: 'string', readOnly: true },
    nested: { type: 'object', properties: { password: { type: 'string', format: 'password' } } },
  },
  allOf: [
    { properties: { token: { $ref: '#/$defs/token' }, fixed: { $ref: '#/$defs/fixed' } } },
    { properties: { nested: { $ref: '#/$defs/nested', default: { password: 'nested-default' } } } },
  ],
  properties: {
    choices: { anyOf: [{ type: 'string' }, { type: 'string', writeOnly: true }] },
    tuple: { type: 'array', items: [{ $ref: '#/$defs/fixed' }, { $ref: '#/$defs/token' }] },
    map: { type: 'object', patternProperties: { '^secret': { $ref: '#/$defs/token' } } },
    conditional: { if: { type: 'string' }, then: { readOnly: true } },
  },
  default: { token: 'root-default', fixed: 'sdk-1', nested: { password: 'root-nested-default' }, choices: 'branch-secret' },
};

test('敏感遮蔽沿本地引用、组合、数组与字典生效，根对象默认值不泄漏', () => {
  const values = { token: 'user-token', fixed: 'sdk-1', nested: { password: 'user-password' }, choices: 'branch-secret', tuple: ['fixed', 'tuple-token'], map: { secretHeader: 'header-token' } };
  const masked = mapSchemaSecrets(schema, values);
  assert.doesNotMatch(JSON.stringify(masked), /user-token|user-password|branch-secret|tuple-token|header-token/);
  assert.deepEqual(mapSchemaSecrets(schema, masked, values, 'restore'), values);
  const redacted = redactSchemaDefaults(schema);
  assert.doesNotMatch(JSON.stringify(redacted), /token-default|root-default|nested-default|root-nested-default|branch-secret/);
  assert.match(JSON.stringify(redacted), /sdk-1/);
});

test('高级只读检查沿引用和组合生效，移除父级或数组项也不能绕过', () => {
  const before = { fixed: 'sdk-1', tuple: ['fixed', 'token'], conditional: 'frozen' };
  assert.deepEqual(readonlyIssues(schema, before, before), []);
  const rejected = readonlyIssues(schema, before, { fixed: 'sdk-2', tuple: [], conditional: 'changed' });
  assert.deepEqual(rejected.map((issue) => issue.path).sort(), ['/conditional', '/fixed', '/tuple/0']);
  assert.ok(readonlyIssues(schema, before, null).some((issue) => issue.path === '/fixed'));
  assert.deepEqual(readonlyIssues({ properties: { fixed: { readOnly: true } } }, { fixed: null }, {}).map((issue) => issue.path), ['/fixed']);
});

test('空对象声明及空引用明确无需配置，引用字段和可编辑映射保持配置入口', () => {
  assert.equal(hasSchemaFields({ type: 'object', properties: {}, additionalProperties: false }), false);
  assert.equal(hasSchemaFields({ $ref: '#/$defs/empty', $defs: { empty: { type: 'object', properties: {} } } }), false);
  assert.equal(hasSchemaFields(schema), true);
  assert.equal(hasSchemaFields({ type: 'object', additionalProperties: true }), true);
});

test('递归本地引用可保护有限深度值，不因 schema 引用环陷入递归', () => {
  const recursive: SchemaValue = { type: 'object', properties: { secret: { writeOnly: true }, child: { $ref: '#' } } };
  assert.deepEqual(mapSchemaSecrets(recursive, { secret: 'first', child: { secret: 'second' } }), { secret: '********', child: { secret: '********' } });
});
