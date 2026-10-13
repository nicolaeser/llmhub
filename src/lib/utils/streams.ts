export async function cancelQuietly(source: { cancel(reason?: unknown): Promise<void> } | null | undefined): Promise<boolean> {
  if (!source) return false;
  try {
    await source.cancel();
    return true;
  } catch {
    return false;
  }
}

export function enqueueQuietly<T>(controller: ReadableStreamDefaultController<T>, chunk: T): boolean {
  try {
    controller.enqueue(chunk);
    return true;
  } catch {
    return false;
  }
}

export function closeQuietly(controller: ReadableStreamDefaultController<unknown>): boolean {
  try {
    controller.close();
    return true;
  } catch {
    return false;
  }
}
