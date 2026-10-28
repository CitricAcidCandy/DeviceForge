// 最小 ZIP STORE 写入器：仅打包本示例显式给定的文件，无 npm 或系统压缩工具依赖。
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  if (files.length > 100 || new Set(files.map(([path]) => path)).size !== files.length)
    throw new Error('归档文件数超限或路径重复');
  const parts = [];
  const entries = [];
  let offset = 0;
  for (const [path, bytes] of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) || path.split('/').some((part) => !part || part === '..'))
      throw new Error('归档必须使用包内相对文件路径');
    if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw new Error('归档条目无效或过大');
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
