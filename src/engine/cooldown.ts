export class Cooldown {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const time = this.now();
    const previous = this.last.get(key) ?? 0;
    if (time - previous < this.windowMs) return false;
    this.last.set(key, time);
    return true;
  }
}
