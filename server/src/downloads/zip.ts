/**
 * A CBZ writer, which is a ZIP writer with a different extension.
 *
 * Written by hand rather than pulled in, because a dependency that exists to
 * concatenate four fixed-layout structs is a dependency to audit forever, and
 * `node:zlib` already ships the only hard part. The subset implemented here is
 * the one every comic reader understands: no ZIP64, no encryption, no data
 * descriptors, no directory entries — sizes are known before the header is
 * written because each page is a whole buffer in hand.
 *
 * Pages are added one at a time and streamed straight to the file handle, so a
 * 60 MB chapter costs one page of memory rather than sixty megabytes of it.
 */
import { deflateRawSync } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Bit 11: the name is UTF-8. Without it a non-ASCII title is mojibake. */
const UTF8_NAME = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 2.0 — the floor for deflate, and what every reader has supported for decades. */
const VERSION = 20;

const CRC_TABLE = new Uint32Array(256).map((_unused, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

/** The CRC-32 ZIP requires. `node:zlib.crc32` is newer than our Node floor. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date and time — two-second resolution, epoch 1980. */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time:
      (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

interface Placed {
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  time: number;
  date: number;
  offset: number;
}

function localHeader(entry: Placed): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_SIGNATURE, 0);
  head.writeUInt16LE(VERSION, 4);
  head.writeUInt16LE(UTF8_NAME, 6);
  head.writeUInt16LE(entry.method, 8);
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.compressed, 18);
  head.writeUInt32LE(entry.uncompressed, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, entry.name]);
}

function centralHeader(entry: Placed): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  head.writeUInt16LE(VERSION, 4);
  head.writeUInt16LE(VERSION, 6);
  head.writeUInt16LE(UTF8_NAME, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.compressed, 20);
  head.writeUInt32LE(entry.uncompressed, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, entry.name]);
}

export interface CbzWriter {
  add(name: string, data: Buffer, when?: Date): Promise<void>;
  finish(): Promise<void>;
}

export function createCbzWriter(file: FileHandle): CbzWriter {
  const entries: Placed[] = [];
  let offset = 0;

  async function append(chunk: Buffer): Promise<void> {
    await file.write(chunk);
    offset += chunk.length;
  }

  return {
    async add(name, data, when = new Date()): Promise<void> {
      // Page images are already compressed; deflating a JPEG usually grows it.
      // Storing in that case costs nothing and keeps the archive honest about
      // its own size.
      const deflated = deflateRawSync(data);
      const shrank = deflated.length < data.length;
      const stamp = dosStamp(when);
      const entry: Placed = {
        name: Buffer.from(name, 'utf8'),
        method: shrank ? METHOD_DEFLATE : METHOD_STORE,
        crc: crc32(data),
        compressed: shrank ? deflated.length : data.length,
        uncompressed: data.length,
        time: stamp.time,
        date: stamp.date,
        offset,
      };
      await append(localHeader(entry));
      await append(shrank ? deflated : data);
      entries.push(entry);
    },

    async finish(): Promise<void> {
      const start = offset;
      for (const entry of entries) await append(centralHeader(entry));
      const end = Buffer.alloc(22);
      end.writeUInt32LE(EOCD_SIGNATURE, 0);
      end.writeUInt16LE(0, 4); // this disk
      end.writeUInt16LE(0, 6); // disk with the central directory
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(offset - start, 12);
      end.writeUInt32LE(start, 16);
      end.writeUInt16LE(0, 20); // comment
      await append(end);
    },
  };
}
