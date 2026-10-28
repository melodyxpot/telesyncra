export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  add(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
