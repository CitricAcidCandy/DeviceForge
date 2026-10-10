import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const xml = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.smoke.packages" android:versionCode="0009" android:versionName="甲&amp;乙"><uses-sdk android:minSdkVersion="23"/><uses-permission android:name="android.permission.INTERNET"/><application android:label="独立服务样本"/></manifest>';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// 独立固定 Stored ZIP；不借用生产核心或平台工具生成期望。
export function storedZip(entries) {
  assert.ok(entries.length > 0 && entries.length <= 8);
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const bytes = Buffer.from(content), path = Buffer.from(name, 'utf8');
    assert.ok(path.length < 256 && bytes.length <= 65536);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(path.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(path.length, 28); central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, bytes); directory.push(central, path);
    offset += local.length + path.length + bytes.length;
  }
  const index = Buffer.concat(directory), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(index.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, footer]);
}

export function apkSample(caseId) {
  assert.match(caseId, /^[a-z0-9_-]+$/);
  return storedZip([['AndroidManifest.xml', Buffer.from([3, 0, 255, 0, 128])],
    ['classes.dex', Buffer.from(`dex\n035\0${caseId}\0`, 'utf8')]]);
}

export function manifestValue(artifactId) {
  return { artifact_id: artifactId, format: 'apk', module: null, package_name: 'org.smoke.packages',
    version_code: '0009', version_name: '甲&乙', min_sdk: '23', target_sdk: null,
    application_label: '独立服务样本', debuggable: null,
    permissions: ['android.permission.INTERNET'], xml };
}
