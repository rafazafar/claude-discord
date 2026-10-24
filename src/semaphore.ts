export class Semaphore {
  private waiting: Array<() => void> = [];
  private used = 0;

  constructor(private readonly size: number) {}

  get inUse(): number {
    return this.used;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.used < this.size) {
      this.used++;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.used--;
    };
  }
}
