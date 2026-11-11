import zlib from 'node:zlib';

/**
 * Pulls one file out of a zip archive held in memory. Enough of the format to open a claude.ai
 * data export: stored and deflated entries, no encryption, no zip64.
 * @param {Buffer} buf
 * @param {(name: string) => boolean} match
 * @returns {Buffer | null}
 */
export function unzipEntry(buf, match) {
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a zip archive.');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (match(name)) {
      if (size === 0xffffffff || local === 0xffffffff) throw new Error('This export is too large to open here. Unzip it and import conversations.json.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('This zip uses a compression method Booardroom cannot read. Unzip it and import conversations.json.');
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
