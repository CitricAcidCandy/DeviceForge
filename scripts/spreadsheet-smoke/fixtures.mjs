import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// 标准无压缩ZIP：本地头、CRC32、中央目录及EOCD均按真实成员字节生成。
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip(members) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of members) {
    const filename = Buffer.from(name), bytes = Buffer.from(value), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(entry, filename); offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, end]);
}
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function column(index) { let result = ''; do { result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26) - 1; } while (index >= 0); return result; }
export function worksheet(rows, dimension) {
  return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (dimension ? '<dimension ref="' + xml(dimension) + '"/>' : '') + '<sheetData>'
    + rows.map((row, r) => '<row r="' + (r + 1) + '">' + row.map((value, c) => {
      if (value == null) return ''; const ref = column(c) + (r + 1);
      if (typeof value === 'boolean') return '<c r="' + ref + '" t="b"><v>' + Number(value) + '</v></c>';
      if (typeof value === 'number') return '<c r="' + ref + '"><v>' + value + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
    }).join('') + '</row>').join('') + '</sheetData></worksheet>';
}
export function workbook(sheets) {
  const typeRoot = 'http://schemas.openxmlformats.org/package/2006/content-types', relationRoot = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const members = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="' + typeRoot + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="' + relationRoot + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xml(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="' + relationRoot + '">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>'],
    ...sheets.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', s.xml ?? worksheet(s.rows, s.dimension)]),
  ];
  return zip(members);
}
export const mainHeaders = ['A', 'A__3', 'A__2', '列4__2', '列4', '中文'];
export const mainRows = [
  ['中文值', 0, false, null, null, '逗号,引号"'],
  ['二行', 1, true, '字段四', '保留', '换行\n内容'],
  ['终行', -2, false, 0, '尾', '😀'],
].map(row => Object.fromEntries(mainHeaders.map((header, i) => [header, row[i]])));
export const pageHeaders = ['编号', '启用', '说明'];
export const pageRows = Array.from({ length: 5 }, (_, i) => ({ 编号: i, 启用: i % 2 === 1, 说明: '分页' + i }));
export const csvHeaders = ['名称', '值', '值__3', '值__2', '列5'];
export const csvRows = [
  { 名称: '逗号,引号"', 值: '0', 值__3: 'false', 值__2: null, 列5: '中文' },
  { 名称: '换行\n内容', 值: '1', 值__3: 'true', 值__2: null, 列5: null },
];
export async function prepareFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const values = {
    '中文多表.XLSX': workbook([
      { name: '中文数据', rows: [[], [' A ', 'A', 'A__2', null, '列4', '中文'], ...[Object.values(mainRows[0]), [], Object.values(mainRows[1]), Object.values(mainRows[2])]] },
      { name: '分页', rows: [pageHeaders, ...pageRows.map(Object.values)] },
      { name: '空表', rows: [] },
    ]),
    '引号与空行.CSV': Buffer.from('\uFEFF名称,值,值,值__2,\r\n"逗号,引号""",0,false,,中文\r\n,,,,\r\n"换行\n内容",1,true,,\r\n'),
    '损坏工作表.xlsx': workbook([{ name: '损坏', xml: '<worksheet><sheetData><row>' }]),
    '坐标膨胀.xlsx': workbook([{ name: '坐标', rows: [['名称'], ['值']], dimension: 'A1:XFD1048576' }]),
    '单元格超限.csv': Buffer.from('内容\n' + '中'.repeat(10923) + '\n'),
    '表头超限.csv': Buffer.from('中'.repeat(171) + '\n值\n'),
    '行数超限.csv': Buffer.from('名称\n' + Array.from({ length: 10001 }, (_, i) => '行' + i).join('\n') + '\n'),
    '输出超限.csv': Buffer.from(Array.from({ length: 40 }, (_, i) => '字段' + i).join(',') + '\n'
      + Array.from({ length: 500 }, (_, r) => Array.from({ length: 40 }, (_, c) => (r + ':' + c + ':').padEnd(60, 'x')).join(',')).join('\n') + '\n'),
  };
  const fixtures = {};
  for (const [name, bytes] of Object.entries(values)) {
    assert.ok(bytes.length <= 16 * 1024 * 1024); const path = join(directory, name);
    // 固定较大CSV按块写，保留真实原字节作为摘要与下载依据。
    const handle = await (await import('node:fs/promises')).open(path, 'wx');
    try { let offset = 0; while (offset < bytes.length) offset += (await handle.write(bytes.subarray(offset, offset + 4096))).bytesWritten; }
    finally { await handle.close(); }
    assert.deepEqual(await readFile(path), bytes); fixtures[name] = { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return fixtures;
}
