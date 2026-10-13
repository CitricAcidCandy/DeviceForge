import { createHash } from 'node:crypto';

export function dexFixture() {
    const names = ['Lcom/example/sdk/Entry$Inner;', 'Lcom/reference/sdk/Entry;'];
    const prefix = Buffer.alloc(160);
    prefix.write('dex\n039\0', 0, 'ascii');
    for (const [offset, value] of [[36, 112], [40, 0x12345678], [56, 2], [60, 112],
        [64, 2], [68, 120], [96, 1], [100, 128], [108, 160], [128, 0],
        [132, 1], [136, 0xffffffff], [144, 0xffffffff]]) prefix.writeUInt32LE(value, offset);
    const strings = names.map(name => Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'ascii'), Buffer.from([0])]));
    prefix.writeUInt32LE(160, 112);
    prefix.writeUInt32LE(160 + strings[0].length, 116);
    prefix.writeUInt32LE(0, 120);
    prefix.writeUInt32LE(1, 124);
    const contentLength = prefix.length + strings.reduce((total, item) => total + item.length, 0);
    const padding = Buffer.alloc((4 - contentLength % 4) % 4);
    const mappingOffset = contentLength + padding.length;
    const entries = [[0, 1, 0], [1, 2, 112], [2, 2, 120], [6, 1, 128], [0x2002, 2, 160], [0x1000, 1, mappingOffset]];
    const mapping = Buffer.alloc(4 + entries.length * 12);
    mapping.writeUInt32LE(entries.length);
    for (const [index, [kind, count, offset]] of entries.entries()) {
        mapping.writeUInt16LE(kind, 4 + index * 12);
        mapping.writeUInt32LE(count, 8 + index * 12);
        mapping.writeUInt32LE(offset, 12 + index * 12);
    }
    const bytes = Buffer.concat([prefix, ...strings, padding, mapping]);
    bytes.writeUInt32LE(bytes.length, 32);
    bytes.writeUInt32LE(mappingOffset, 52);
    bytes.writeUInt32LE(bytes.length - 160, 104);
    createHash('sha1').update(bytes.subarray(32)).digest().copy(bytes, 12);
    let low = 1, high = 0;
    for (const byte of bytes.subarray(12)) { low = (low + byte) % 65521; high = (high + low) % 65521; }
    bytes.writeUInt32LE(((high << 16) | low) >>> 0, 8);
    return bytes;
}
