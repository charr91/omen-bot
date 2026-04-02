import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TerminalDashboard } from '../../../src/tui/dashboard.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  readonly setRawMode = vi.fn<(value: boolean) => void>();
  readonly resume = vi.fn<() => void>();
  readonly pause = vi.fn<() => void>();
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 20;
  readonly writes: string[] = [];
  readonly write = vi.fn<(chunk: string) => boolean>((chunk) => {
    this.writes.push(chunk);
    return true;
  });
}

describe('TerminalDashboard', () => {
  it('shows shutdown feedback immediately and invokes quit only once', () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const onQuit = vi.fn();
    const dashboard = new TerminalDashboard({
      dryRun: false,
      onQuit,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    dashboard.start();
    stdin.emit('keypress', '', { name: 'q' });
    stdin.emit('keypress', '', { name: 'q' });

    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(stdout.writes.at(-1)).toContain('Shutting down...');
    expect(stdout.writes.at(-1)).toContain('State:STOPPING');

    dashboard.stop();
  });
});
