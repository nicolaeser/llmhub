import { gunzipSync } from "node:zlib";
import type { ConnectFrame, ProtoField } from "@/types/devin";

export const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

const CONNECT_HEADER_BYTES = 5;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_VARINT_BYTES = 10;
const KNOWN_FLAGS = new Set([0, CONNECT_FLAG_COMPRESSED, CONNECT_FLAG_END_STREAM, CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM]);

const encoder = new TextEncoder();
const ZERO = BigInt(0);
const SEVEN_BITS = BigInt(7);
const LOW_SEVEN = BigInt(0x7f);
const CONTINUE = BigInt(0x80);
const TAG_SHIFT = BigInt(3);
const WIRE_MASK = BigInt(7);

function varintBytes(value: bigint): number[] {
  const out: number[] = [];
  let rest = BigInt.asUintN(64, value);
  while (rest >= CONTINUE) {
    out.push(Number((rest & LOW_SEVEN) | CONTINUE));
    rest >>= SEVEN_BITS;
  }
  out.push(Number(rest));
  return out;
}

export class ProtoWriter {
  private parts: Uint8Array[] = [];

  private tag(field: number, wire: number): void {
    this.parts.push(Uint8Array.from(varintBytes((BigInt(field) << TAG_SHIFT) | BigInt(wire))));
  }

  varint(field: number, value: number | bigint): this {
    this.tag(field, WIRE_VARINT);
    this.parts.push(Uint8Array.from(varintBytes(BigInt(value))));
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, WIRE_BYTES);
    this.parts.push(Uint8Array.from(varintBytes(BigInt(value.length))), value);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, encoder.encode(value));
  }

  message(field: number, value: ProtoWriter): this {
    return this.bytes(field, value.finish());
  }

  double(field: number, value: number): this {
    this.tag(field, WIRE_FIXED64);
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setFloat64(0, value, true);
    this.parts.push(buffer);
    return this;
  }

  finish(): Uint8Array<ArrayBuffer> {
    const size = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function readVarint(data: Uint8Array, start: number): { value: bigint; next: number } {
  let value = ZERO;
  for (let index = 0; index < MAX_VARINT_BYTES; index++) {
    const position = start + index;
    if (position >= data.length) throw new Error("PROTO_TRUNCATED");
    const byte = data[position]!;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if ((byte & 0x80) === 0) return { value: BigInt.asUintN(64, value), next: position + 1 };
  }
  throw new Error("PROTO_MALFORMED");
}

function fixedSlice(data: Uint8Array, start: number, size: number): Uint8Array {
  if (start + size > data.length) throw new Error("PROTO_TRUNCATED");
  return data.subarray(start, start + size);
}

export function protoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let position = 0;
  while (position < data.length) {
    const tag = readVarint(data, position);
    position = tag.next;
    const field = Number(tag.value >> TAG_SHIFT);
    const wire = Number(tag.value & WIRE_MASK);
    if (field <= 0) throw new Error("PROTO_MALFORMED");
    if (wire === WIRE_VARINT) {
      const read = readVarint(data, position);
      position = read.next;
      fields.push({ field, wire, varint: read.value, bytes: new Uint8Array() });
    } else if (wire === WIRE_BYTES) {
      const length = readVarint(data, position);
      const size = Number(length.value);
      const bytes = fixedSlice(data, length.next, size);
      position = length.next + size;
      fields.push({ field, wire, varint: ZERO, bytes });
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      const size = wire === WIRE_FIXED64 ? 8 : 4;
      const bytes = fixedSlice(data, position, size);
      position += size;
      fields.push({ field, wire, varint: ZERO, bytes });
    } else {
      throw new Error("PROTO_MALFORMED");
    }
  }
  return fields;
}

export function safeProtoFields(data: Uint8Array): ProtoField[] {
  try {
    return protoFields(data);
  } catch {
    return [];
  }
}

export function protoText(field: ProtoField): string {
  return new TextDecoder().decode(field.bytes);
}

export function protoNumber(field: ProtoField): number {
  return Number(BigInt.asIntN(64, field.varint));
}

export function protoDouble(field: ProtoField): number {
  return field.bytes.length === 8 ? new DataView(field.bytes.buffer, field.bytes.byteOffset, 8).getFloat64(0, true) : 0;
}

export function protoFloat(field: ProtoField): number {
  return field.bytes.length === 4 ? new DataView(field.bytes.buffer, field.bytes.byteOffset, 4).getFloat32(0, true) : 0;
}

export function connectEnvelope(payload: Uint8Array, flag = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(CONNECT_HEADER_BYTES + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, CONNECT_HEADER_BYTES);
  return out;
}

function inflated(frame: ConnectFrame): ConnectFrame {
  if ((frame.flag & CONNECT_FLAG_COMPRESSED) === 0) return frame;
  const payload = gunzipSync(frame.payload, { maxOutputLength: MAX_INFLATED_BYTES });
  return { flag: frame.flag, payload: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) };
}

export class ConnectFrameReader {
  private buffer = new Uint8Array();

  push(chunk: Uint8Array): ConnectFrame[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const frames: ConnectFrame[] = [];
    while (this.buffer.length >= CONNECT_HEADER_BYTES) {
      const flag = this.buffer[0]!;
      if (!KNOWN_FLAGS.has(flag)) throw new Error("CONNECT_FRAME_INVALID");
      const size = new DataView(this.buffer.buffer, this.buffer.byteOffset, CONNECT_HEADER_BYTES).getUint32(1, false);
      if (size > MAX_FRAME_BYTES) throw new Error("CONNECT_FRAME_TOO_LARGE");
      if (this.buffer.length < CONNECT_HEADER_BYTES + size) break;
      const payload = this.buffer.slice(CONNECT_HEADER_BYTES, CONNECT_HEADER_BYTES + size);
      this.buffer = this.buffer.slice(CONNECT_HEADER_BYTES + size);
      frames.push(inflated({ flag, payload }));
    }
    return frames;
  }

  get pending(): boolean {
    return this.buffer.length > 0;
  }
}

export function connectFrames(data: Uint8Array): { frames: ConnectFrame[]; complete: boolean } {
  const reader = new ConnectFrameReader();
  const frames = reader.push(data);
  return { frames, complete: !reader.pending };
}
