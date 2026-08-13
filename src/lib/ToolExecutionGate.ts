import { McpError } from '@modelcontextprotocol/sdk/types.js';

interface QueuedOperation<T> {
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class ToolExecutionGate {
  private active = 0;
  private readonly queue: QueuedOperation<unknown>[] = [];

  constructor(private readonly concurrency: number, private readonly maxQueued: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) return this.execute(operation);
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new McpError(429, 'Tool execution queue is full. Retry after current SAP operations finish.'));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ operation, resolve, reject } as QueuedOperation<unknown>);
    });
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    while (this.active < this.concurrency) {
      const next = this.queue.shift();
      if (!next) return;
      this.execute(next.operation).then(next.resolve, next.reject);
    }
  }
}
