export class SizedLru<V> {
  private readonly entries = new Map<string, { value: V; size: number }>();
  private used = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.used;
  }

  get count(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, size: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.used -= previous.size;
    }
    if (size > this.capacity) return;
    this.entries.set(key, { value, size });
    this.used += size;
    for (const [oldest, entry] of this.entries) {
      if (this.used <= this.capacity) break;
      this.entries.delete(oldest);
      this.used -= entry.size;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.used -= entry.size;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}
