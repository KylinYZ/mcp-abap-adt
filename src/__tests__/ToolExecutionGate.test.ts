import { ToolExecutionGate } from '../lib/ToolExecutionGate';

describe('ToolExecutionGate', () => {
  it('runs queued work in FIFO order without overlap', async () => {
    const gate = new ToolExecutionGate(1, 2);
    const events: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const first = gate.run(async () => { events.push('first-start'); await blocker; events.push('first-end'); });
    const second = gate.run(async () => { events.push('second'); });
    const third = gate.run(async () => { events.push('third'); });
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    release();
    await Promise.all([first, second, third]);
    expect(events).toEqual(['first-start', 'first-end', 'second', 'third']);
  });

  it('releases a slot when an operation throws', async () => {
    const gate = new ToolExecutionGate(1, 1);
    const failed = gate.run(async () => { throw new Error('boom'); });
    const next = gate.run(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('rejects immediately when the queue is full', async () => {
    const gate = new ToolExecutionGate(1, 1);
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const running = gate.run(() => blocker);
    const queued = gate.run(async () => undefined);
    const callback = jest.fn(async () => undefined);
    await expect(gate.run(callback)).rejects.toMatchObject({ code: 429 });
    expect(callback).not.toHaveBeenCalled();
    release();
    await Promise.all([running, queued]);
  });

  it('never exceeds the configured concurrency', async () => {
    const gate = new ToolExecutionGate(2, 2);
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 4 }, () => gate.run(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    }));
    await Promise.all(tasks);
    expect(maximum).toBe(2);
  });

  it('rejects immediately with a zero-length queue', async () => {
    const gate = new ToolExecutionGate(1, 0);
    let release!: () => void;
    const running = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({ code: 429 });
    release();
    await running;
  });
});
