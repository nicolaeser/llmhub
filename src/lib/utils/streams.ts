export async function cancelQuietly(source: { cancel(reason?: unknown): Promise<void> } | null | undefined): Promise<boolean> {
  if (!source) return false;
  try {
    await source.cancel();
    return true;
  } catch {
    return false;
  }
}

export class DeadlineReader<T> {
  private pending: Promise<ReadableStreamReadResult<T>> | null = null;

  constructor(private readonly reader: ReadableStreamDefaultReader<T>) {}

  async read(waitMs: number): Promise<ReadableStreamReadResult<T> | null> {
    this.pending ??= this.reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, waitMs), null);
    });
    try {
      const result = await Promise.race([this.pending, lapse]);
      if (result) this.pending = null;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function withIdleTimeout<T>(
  source: ReadableStream<T>,
  idleMs: number,
  stalled: () => Error,
): ReadableStream<T> {
  const reader = source.getReader();
  const reads = new DeadlineReader(reader);
  return new ReadableStream<T>(
    {
      async pull(controller) {
        const read = await reads.read(idleMs);
        if (!read) {
          const err = stalled();
          void reader.cancel(err).catch(() => undefined);
          controller.error(err);
          return;
        }
        if (read.done) controller.close();
        else controller.enqueue(read.value);
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
