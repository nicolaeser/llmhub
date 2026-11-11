import { pipeline, Readable, type Transform } from "node:stream";

export const LINE_BATCH_BYTES = 64 * 1024;

export function piped(source: AsyncIterable<Buffer>, transform: Transform): AsyncIterable<Buffer> {
  return pipeline(Readable.from(source, { objectMode: false }), transform, () => undefined);
}

export async function* jsonLines(
  records: AsyncIterable<Record<string, unknown>>,
  tally: { rows: number; bytes: number; hash: { update: (data: Buffer) => unknown } },
  batchBytes = LINE_BATCH_BYTES,
): AsyncGenerator<Buffer> {
  let batch: Buffer[] = [];
  let size = 0;
  for await (const record of records) {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    tally.rows += 1;
    tally.bytes += line.length;
    tally.hash.update(line);
    batch.push(line);
    size += line.length;
    if (size >= batchBytes) {
      yield Buffer.concat(batch, size);
      batch = [];
      size = 0;
    }
  }
  if (size) yield Buffer.concat(batch, size);
}
