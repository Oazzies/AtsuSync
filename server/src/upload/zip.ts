import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const u16 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/**
 * Minimal ZIP writer, entries stored uncompressed. Page images are already compressed, so
 * deflating them would only cost time. Page counts stay far below the 65535-entry / 4 GB limits.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const crc = crc32(data);
    const flags = 0x0800; // UTF-8 names
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(0), u16(0), u16(0x21), // version, flags, stored, time 00:00, date 1980-01-01
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf,
    ]);
    central.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(0), u16(0x21),
        u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
      ]),
    );
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, centralBuf, end]);
}
