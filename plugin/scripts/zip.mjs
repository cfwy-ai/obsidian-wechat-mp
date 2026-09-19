import { open, readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

/** ZIP 2.0 with explicit UTF-8 names and fixed timestamps, portable across OSes. */
export async function writeZip(output, files) {
  if (files.length >= 65535) throw new Error('发布包文件数量超过 ZIP 2.0 上限');
  const handle = await open(output, 'wx');
  const central = [];
  let offset = 0;
  try {
    for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (/^(?:\/|[a-z]:)/i.test(file.name) || file.name.split('/').some(part => !part || part === '.' || part === '..') || file.name.includes('\\')) throw new Error('ZIP 路径不安全');
      const name = Buffer.from(file.name, 'utf8');
      if (name.length > 65535) throw new Error('ZIP 路径过长');
      const bytes = await readFile(file.path);
      const compressed = deflateRawSync(bytes, { level: 6 });
      const checksum = crc32(bytes);
      if (offset + compressed.length + name.length + 30 >= 0xffffffff) throw new Error('发布包超过 ZIP 2.0 容量上限');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 flag: required for Chinese names.
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(20513, 12); // 2020-01-01, no local-time dependency.
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50, 0);
      directory.writeUInt16LE((3 << 8) | 20, 4);
      local.copy(directory, 6, 4, 30);
      directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      directory.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([directory, name]));
      for (const block of [local, name, compressed]) await handle.writeFile(block);
      offset += local.length + name.length + compressed.length;
    }
    const centralSize = central.reduce((sum, block) => sum + block.length, 0);
    if (offset + centralSize >= 0xffffffff) throw new Error('发布包目录超过 ZIP 2.0 上限');
    for (const block of central) await handle.writeFile(block);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    await handle.writeFile(end);
  } finally { await handle.close(); }
}
