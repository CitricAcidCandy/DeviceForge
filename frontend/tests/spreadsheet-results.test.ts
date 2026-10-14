import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/shared/api/index.ts';
import { decodeInspection, decodePage } from '../src/features/spreadsheet/domain/results.ts';
import { normalizeInspect, normalizeRead } from '../src/features/spreadsheet/domain/rules.ts';

const artifact = '12345678-1234-1234-1234-123456789abc';
function inspection(changes: Record<string, unknown> = {}) {
  return { format_version: 1, artifact_id: artifact, source_filename: '导入.xlsx', format: 'xlsx',
    sheets: [{ name: 'Sheet1', index: 0 }, { name: '第二页', index: 1 }], ...changes };
}
function page(changes: Record<string, unknown> = {}) {
  return { ...inspection(), sheet_name: 'Sheet1', headers: ['名称', '数量', '启用'], rows: [{ 名称: '示例', 数量: 0, 启用: false }],
    total_rows: 1, offset: 0, limit: 100, ...changes };
}
const wrapped = (result: unknown) => ({ result, artifacts: [] });
const rejected = (value: unknown) => assert.throws(() => decodePage(wrapped(value), 'page-log', { artifact_id: artifact }),
  (error: unknown) => error instanceof ApiError && error.code === 'invalid_business_result' && error.logId === 'page-log');

test('inspect支持三格式与CSV固定表，结果建立深度只读副本', () => {
  for (const format of ['xlsx', 'xls', 'csv']) {
    const value = inspection({ format, ...(format === 'csv' ? { source_filename: '导入.csv', sheets: [{ name: 'CSV', index: 0 }] } : {}) });
    const result = decodeInspection(wrapped(value), 'inspect-log', { artifact_id: artifact });
    assert.deepEqual(result, value); assert.notEqual(result, value); assert.ok(Object.isFrozen(result.sheets));
    assert.ok(Object.isFrozen(result.sheets[0]));
  }
});

test('read保留null、空串、零与false，空表和越过总数空页符合合同', () => {
  const result = decodePage(wrapped(page({ headers: ['空值', '空串', '数量', '启用'], rows: [{ 空值: null, 空串: '', 数量: 0, 启用: false }] })), null, { artifact_id: artifact });
  assert.deepEqual(result.rows[0], { 空值: null, 空串: '', 数量: 0, 启用: false }); assert.ok(Object.isFrozen(result.rows[0]));
  const empty = decodePage(wrapped(page({ headers: [], rows: [], total_rows: 0 })), null, { artifact_id: artifact });
  assert.deepEqual(empty.headers, []);
  const beyond = decodePage(wrapped(page({ rows: [], offset: 10000, limit: 500 })), null, { artifact_id: artifact, offset: 10000, limit: 500 });
  assert.equal(beyond.offset, 10000); assert.deepEqual(beyond.rows, []);
});

test('sheet只按精确名称和索引选择，省略取第一表，显式错误不回退', () => {
  const second = page({ sheet_name: '第二页' });
  assert.equal(decodePage(wrapped(second), null, { artifact_id: artifact, sheet: 1 }).sheet_name, '第二页');
  assert.equal(decodePage(wrapped(second), null, { artifact_id: artifact, sheet: '第二页' }).sheet_name, '第二页');
  for (const sheet of ['第二页 ', 'second', 2]) assert.throws(() => decodePage(wrapped(second), 'page-log', { artifact_id: artifact, sheet }), ApiError);
  rejected(second);
});

test('结果拒绝版本、归属、未知字段和非空产物封套', () => {
  for (const value of [page({ format_version: 2 }), page({ artifact_id: 'other' }), page({ format: ['xlsx'] }), page({ private_path: 'server-file' })]) rejected(value);
  assert.throws(() => decodeInspection(inspection(), null, { artifact_id: artifact }), ApiError);
  assert.throws(() => decodeInspection({ result: inspection(), artifacts: [{}] }, null, { artifact_id: artifact }), ApiError);
});

test('表目录连续且唯一，CSV只能一张CSV表，UTF8边界按字节计算', () => {
  const bad = [inspection({ sheets: [] }), inspection({ sheets: [{ name: 'Sheet1', index: 1 }] }),
    inspection({ sheets: [{ name: 'A', index: 0 }, { name: 'A', index: 1 }] }), inspection({ sheets: [{ name: '中'.repeat(171), index: 0 }] }),
    inspection({ sheets: Array.from({ length: 65 }, (_, index) => ({ name: 'S' + index, index })) }),
    inspection({ source_filename: '中'.repeat(61) }), inspection({ format: 'csv' }), inspection({ format: 'csv', sheets: [{ name: 'csv', index: 0 }] })];
  for (const value of bad) assert.throws(() => decodeInspection(wrapped(value), 'inspect-log', { artifact_id: artifact }), ApiError);
  assert.ok(decodeInspection(wrapped(inspection({ sheets: [{ name: '中'.repeat(170), index: 0 }], source_filename: '中'.repeat(60) })), null, { artifact_id: artifact }));
});

test('行键严格等于表头，表头唯一且有界，非法值和分页矛盾拒绝', () => {
  for (const value of [page({ headers: ['A', 'A'] }), page({ headers: [''] }), page({ headers: Array.from({ length: 257 }, (_, index) => 'C' + index) }),
    page({ headers: ['中'.repeat(171)] }), page({ rows: [{ 名称: '缺键', 数量: 0 }] }), page({ rows: [{ 名称: '多键', 数量: 0, 启用: false, extra: null }] }),
    page({ rows: [{ 名称: 'bad', 数量: NaN, 启用: false }] }), page({ rows: [{ 名称: 'bad', 数量: {}, 启用: false }] }),
    page({ rows: [{ 名称: undefined, 数量: 0, 启用: false }] }), page({ total_rows: 10001 }), page({ offset: 1 }),
    page({ limit: 0 }), page({ limit: 501 }), page({ rows: [] }), page({ headers: [], rows: [{}] }),
    page({ rows: [{ 名称: 'x'.repeat(32769), 数量: 0, 启用: false }] }), page({ rows: [{ 名称: '\ud800', 数量: 0, 启用: false }] })]) rejected(value);
  assert.ok(decodePage(wrapped(page({ rows: [{ 名称: 'x'.repeat(32768), 数量: 0, 启用: false }] })), null, { artifact_id: artifact }));
});

test('整体序列化结果超过1MiB拒绝，不以单格合格代替总量门禁', () => {
  const headers = Array.from({ length: 40 }, (_, index) => 'C' + index);
  const rows = [Object.fromEntries(headers.map((header) => [header, 'x'.repeat(32768)]))];
  rejected(page({ headers, rows }));
});

test('输入规范UUID并保留省略默认，显式undefined及无效参数拒绝', () => {
  assert.deepEqual(normalizeInspect({ artifact_id: artifact.toUpperCase() }), { artifact_id: artifact });
  assert.deepEqual(normalizeRead({ artifact_id: artifact }), { artifact_id: artifact });
  const explicit = normalizeRead({ artifact_id: artifact, sheet: ' 第二页 ', offset: 10000, limit: 500 });
  assert.equal(explicit.sheet, ' 第二页 '); assert.ok(Object.isFrozen(explicit));
  for (const value of [{ artifact_id: 'C:/book.xlsx' }, { artifact_id: artifact, file: 'local' }]) assert.throws(() => normalizeInspect(value), ApiError);
  for (const input of [{ artifact_id: artifact, sheet: '' }, { artifact_id: artifact, sheet: -1 }, { artifact_id: artifact, sheet: 0.5 },
    { artifact_id: artifact, offset: -1 }, { artifact_id: artifact, offset: 10001 }, { artifact_id: artifact, limit: 0 },
    { artifact_id: artifact, limit: 501 }, { artifact_id: artifact, sheet: '中'.repeat(171) }]) assert.throws(() => normalizeRead(input), ApiError);
  const nullable = JSON.parse('{"artifact_id":"' + artifact + '","sheet":null}');
  assert.throws(() => normalizeRead(nullable), ApiError);
  const undefinedInput = { artifact_id: artifact };
  Object.defineProperty(undefinedInput, 'offset', { value: undefined, enumerable: true });
  assert.throws(() => normalizeRead(undefinedInput), ApiError);
});
