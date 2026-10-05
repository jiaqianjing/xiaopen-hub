import { randomBytes } from "node:crypto";

const OGG_CRC_POLY = 0x04c11db7;
const CRC_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let value = i << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      value & 0x80000000
        ? ((value << 1) ^ OGG_CRC_POLY) >>> 0
        : (value << 1) >>> 0;
  }
  CRC_TABLE[i] = value;
}

function checksum(buffer: Buffer): number {
  let crc = 0;
  for (const byte of buffer) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc;
}

function makePage(
  packet: Buffer,
  serial: number,
  sequence: number,
  granule: bigint,
  headerType: number,
): Buffer {
  const segments: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  segments.forEach((value, index) => {
    header[27 + index] = value;
  });
  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(checksum(page), 22);
  return page;
}

export function opusPacketsToOgg(
  packets: Buffer[],
  inputSampleRate = 16000,
  frameDurationMs = 60,
): Buffer {
  const serial = randomBytes(4).readUInt32LE(0);
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(inputSampleRate, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;

  const vendor = Buffer.from("xiaopen-hub", "utf8");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [
    makePage(head, serial, 0, BigInt(0), 0x02),
    makePage(tags, serial, 1, BigInt(0), 0x00),
  ];
  const samplesPerFrame = BigInt(Math.round((48000 * frameDurationMs) / 1000));
  let granule = BigInt(312);
  packets.forEach((packet, index) => {
    granule += samplesPerFrame;
    pages.push(
      makePage(
        packet,
        serial,
        index + 2,
        granule,
        index === packets.length - 1 ? 0x04 : 0x00,
      ),
    );
  });
  return Buffer.concat(pages);
}

export function oggToOpusPackets(ogg: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  let pending: Buffer[] = [];
  while (offset + 27 <= ogg.length) {
    if (ogg.toString("ascii", offset, offset + 4) !== "OggS") {
      throw new Error("TTS 返回的不是有效 Ogg/Opus 音频");
    }
    const segmentCount = ogg[offset + 26];
    const tableStart = offset + 27;
    const payloadStart = tableStart + segmentCount;
    if (payloadStart > ogg.length) {
      throw new Error("Ogg 页头不完整");
    }
    let payloadOffset = payloadStart;
    for (let index = 0; index < segmentCount; index += 1) {
      const length = ogg[tableStart + index];
      if (payloadOffset + length > ogg.length) {
        throw new Error("Ogg 音频数据不完整");
      }
      pending.push(ogg.subarray(payloadOffset, payloadOffset + length));
      payloadOffset += length;
      if (length < 255) {
        const packet = Buffer.concat(pending);
        pending = [];
        if (
          packet.toString("ascii", 0, 8) !== "OpusHead" &&
          packet.toString("ascii", 0, 8) !== "OpusTags"
        ) {
          packets.push(packet);
        }
      }
    }
    offset = payloadOffset;
  }
  if (!packets.length) {
    throw new Error("TTS 音频中没有 Opus 数据帧");
  }
  return packets;
}
