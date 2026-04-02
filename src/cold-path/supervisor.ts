import { spawn, type ChildProcess } from 'node:child_process';
import type { AppConfig } from '../config/schema.js';

const DEFAULT_RESTART_DELAY_MS = 1_000;

interface ColdWorkerSupervisorOptions {
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
  restartDelayMs?: number;
}

export class ColdWorkerSupervisor {
  private child: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private readonly config: Pick<AppConfig, 'coldPath'>,
    private readonly options: ColdWorkerSupervisorOptions = {},
  ) {}

  start(): void {
    if (this.child || this.stopping) {
      return;
    }

    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (!child) {
      return;
    }

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.kill('SIGTERM');
    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      wait(this.config.coldPath.shutdownTimeoutMs).then(() => true),
    ]);

    if (timedOut) {
      child.kill('SIGKILL');
      await exitPromise;
    }

    this.child = null;
  }

  private spawnChild(): void {
    let handledUnexpectedExit = false;
    const runtimeUrl = resolveColdWorkerRuntimeUrl().href;
    const child = spawn(process.execPath, buildBootstrapArgs(), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMEN_COLD_WORKER_RUNTIME_URL: runtimeUrl,
      },
      stdio: 'inherit',
    });
    this.child = child;
    this.options.onInfo?.(
      `[cold-worker] spawned pid ${child.pid ?? 'unknown'} with runtime ${runtimeUrl}`,
    );

    const handleUnexpectedExit = (message: string): void => {
      if (handledUnexpectedExit || this.stopping) {
        return;
      }

      handledUnexpectedExit = true;
      if (this.child === child) {
        this.child = null;
      }
      this.options.onError?.(message);
      this.scheduleRestart();
    };

    child.once('error', (error) => {
      handleUnexpectedExit(`[cold-worker] failed to spawn: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopping) {
        return;
      }

      const exitDetail =
        code !== null ? `code ${code}` : signal !== null ? `signal ${signal}` : 'unknown exit';
      handleUnexpectedExit(`[cold-worker] exited unexpectedly (${exitDetail}); restarting`);
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) {
      return;
    }

    const restartDelayMs = this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) {
        this.spawnChild();
      }
    }, restartDelayMs);

    if (this.restartTimer && typeof this.restartTimer.unref === 'function') {
      this.restartTimer.unref();
    }
  }
}

function buildBootstrapArgs(): string[] {
  return [
    '--eval',
    `
const runtimeUrl = process.env.OMEN_COLD_WORKER_RUNTIME_URL;

(async () => {
  if (!runtimeUrl) {
    throw new Error('OMEN_COLD_WORKER_RUNTIME_URL is not set');
  }

  if (runtimeUrl.endsWith('.ts')) {
    const { register } = await import('tsx/esm/api');
    register();
  }

  const runtime = await import(runtimeUrl);
  if (typeof runtime.runColdWorkerCommand !== 'function') {
    throw new Error('Cold worker runtime did not export runColdWorkerCommand');
  }

  await runtime.runColdWorkerCommand();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
  ];
}

function resolveColdWorkerRuntimeUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './runtime.ts' : './runtime.js', import.meta.url);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}
