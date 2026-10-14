import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Start the add-on under test, wait until it answers, and stop it afterwards.
 *
 * The command runs in its own process group, so a server started through `npm run` or a
 * shell script is stopped together with everything it started.
 */

export class ServerProcess {
  readonly #child: ChildProcess;
  #log = '';
  #exited: number | null = null;

  private constructor(child: ChildProcess) {
    this.#child = child;
    const keep = (chunk: Buffer) => {
      // The tail is what explains a crash; the rest is noise.
      this.#log = (this.#log + chunk.toString()).slice(-8_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', (code) => {
      this.#exited = code ?? 1;
    });
  }

  /** What the server printed most recently, for a failure message. */
  get log(): string {
    return this.#log.trim();
  }

  static async start(opts: {
    command: string;
    ready: string;
    env: Record<string, string>;
    cwd: string;
    timeoutMs?: number;
  }): Promise<ServerProcess> {
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const server = new ServerProcess(child);
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (server.#exited !== null)
        throw new Error(
          `the server command exited (${server.#exited}) before it was ready:\n${server.log}`,
        );
      try {
        // Any answer at all means something is listening; the scenario finds out the rest.
        await fetch(opts.ready, { signal: AbortSignal.timeout(1_000) });
        return server;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await server.stop();
    throw new Error(
      `the server did not answer at ${opts.ready} within the time allowed:\n${server.log}`,
    );
  }

  async stop(): Promise<void> {
    if (this.#exited !== null || this.#child.pid === undefined) return;
    const gone = new Promise<void>((r) => this.#child.once('exit', () => r()));
    try {
      process.kill(-this.#child.pid, 'SIGTERM');
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-this.#child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 3_000);
    await gone;
    clearTimeout(timer);
  }
}

/** Run a setup command and read the member tokens it prints as JSON: {"ada": "token", ...}. */
export async function runSetup(opts: {
  command: string;
  env: Record<string, string>;
  cwd: string;
}): Promise<Record<string, string>> {
  const child = spawn(opts.command, {
    shell: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)));
  if (code !== 0) throw new Error(`setup exited ${code}:\n${err.trim().slice(-2_000)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.trim().split('\n').at(-1) ?? '');
  } catch {
    throw new Error(
      `setup must print JSON mapping member ids to tokens as its last line; it printed:\n${out.slice(-500)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('setup must print a JSON object mapping member ids to tokens');
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') tokens[k] = v;
  return tokens;
}
