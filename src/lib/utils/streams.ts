export async function cancelQuietly(source: { cancel(reason?: unknown): Promise<void> } | null | undefined): Promise<boolean> {
  if (!source) return false;
  try {
    await source.cancel();
    return true;
  } catch {
    return false;
  }
}
