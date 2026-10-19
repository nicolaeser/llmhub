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
