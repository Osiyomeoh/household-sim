/**
 * Story time.
 *
 * A household's day runs on hours, and a test cannot wait for them. The clock is frozen at
 * the scenario's start and moves only when a step moves it, so a run is repeatable. The
 * assistant's sense of "today" follows it, and so does the server's when it names a header
 * to read it from - a server should only believe that header in a test copy, never in a
 * real household.
 */

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export class StoryClock {
  #at: number | null;
  readonly header: string | undefined;

  constructor(start?: string, header?: string) {
    this.#at = start === undefined ? null : Date.parse(start);
    if (this.#at !== null && Number.isNaN(this.#at)) throw new Error(`"${start}" is not a time`);
    this.header = header;
  }

  /** Whether the scenario runs on story time rather than the real time. */
  get frozen(): boolean {
    return this.#at !== null;
  }

  now(): Date {
    return this.#at === null ? new Date() : new Date(this.#at);
  }

  /** `+2h`, `+90m`, `+1d`, combinations like `+1h30m`, or an absolute ISO time. */
  move(to: string): Date {
    if (this.#at === null)
      throw new Error('this scenario has no clock: add `clock: { start: ... }` to move time');
    const rel = /^\+((?:\d+[mhd])+)$/.exec(to.trim());
    if (rel) {
      let ms = 0;
      for (const [, n, unit] of rel[1]!.matchAll(/(\d+)([mhd])/g)) ms += Number(n) * UNITS[unit!]!;
      this.#at += ms;
    } else {
      const abs = Date.parse(to);
      if (Number.isNaN(abs)) throw new Error(`"${to}" is neither +2h/+30m/+1d nor a time`);
      if (abs < this.#at) throw new Error(`the clock only moves forward (${to} is in the past)`);
      this.#at = abs;
    }
    return this.now();
  }

  /** The header to send on every request, when the scenario names one. */
  headers(): Record<string, string> {
    return this.header && this.#at !== null ? { [this.header]: this.now().toISOString() } : {};
  }
}

/** "Wednesday, October 14, 2026 at 7:30 AM" in the household's own zone. */
export function spokenTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}
