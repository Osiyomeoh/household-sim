import { dirname, resolve } from 'node:path';
import { Assistant, type ToolCall, type Turn } from './assistant.js';
import { StoryClock, spokenTime } from './clock.js';
import {
  DEFAULT_MODEL,
  Player,
  Recorder,
  StaleCassette,
  cassettePath,
  providerFromSpec,
  type ModelProvider,
} from './providers/index.js';
import { resolveValue, type Expect, type Scenario, type Step } from './scenario.js';
import { ServerProcess, runSetup } from './server-process.js';
import { sendWebhook } from './webhook.js';

/**
 * Run a scenario against a live MCP server and check what happened.
 *
 * Every step is checked as it runs and reported on its own, so one bad reply does not hide
 * the rest of the story. `bail` stops at the first failure instead.
 */

export type Mode = 'live' | 'record' | 'replay';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface StepReport {
  index: number;
  kind: Step['kind'];
  label: string;
  ok: boolean;
  skipped?: boolean;
  checks: Check[];
  /** The step could not run at all: the server refused, the recording ran out, and so on. */
  error?: string;
  reply?: string;
  calls?: ToolCall[];
  modelTurns?: number;
  status?: number;
  body?: string;
  ms: number;
}

export interface RunReport {
  scenario: string;
  file: string;
  model: string;
  mode: Mode;
  ok: boolean;
  steps: StepReport[];
  /** Things a reader should know that are not failures, such as a stale recording. */
  notes: string[];
  /** The run could not start: no server, a broken setup command. */
  error?: string;
  /** The tail of the server's output, when the runner started it and something failed. */
  serverLog?: string;
  ms: number;
}

export interface RunOptions {
  /** Overrides the scenario's host.model. */
  model?: string;
  mode?: Mode;
  /** Where the recording lives; defaults to cassettes/<scenario>.json beside the file. */
  cassette?: string;
  /** A server that is already running. The scenario's start command is then not used. */
  url?: string;
  bail?: boolean;
  /** A model to use instead of one built from the spec. Tests use this. */
  provider?: ModelProvider;
  onStep?: (step: StepReport) => void;
}

const MARKDOWN = /(\*\*|__|`|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|\[[^\]]+\]\([^)]+\))/m;
const LINK = /\bhttps?:\/\/|\bwww\./i;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Why a reply would sound wrong read aloud, if it would. */
export function speakableProblems(reply: string): string[] {
  const out: string[] = [];
  if (MARKDOWN.test(reply)) out.push('it has markdown, which a voice reads out as symbols');
  if (LINK.test(reply)) out.push('it has a link, which nobody can tap on a speaker');
  if (EMOJI.test(reply)) out.push('it has an emoji');
  return out;
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

const short = (s: string, n = 160): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function checkSay(turn: Turn, step: Expect, always: Expect): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined || ok ? { name, ok } : { name, ok, detail });
  const names = turn.calls.map((c) => c.name);
  const heard = names.length ? names.join(', ') : 'no tools';

  if (turn.outcome === 'step_limit')
    add('finishes', false, `still calling tools after ${turn.modelTurns} model turns (${heard})`);
  add('says something', turn.reply.trim() !== '', 'the reply was empty');

  for (const tool of step.called ?? [])
    add(`calls ${tool}`, names.includes(tool), `called ${heard}`);
  if (step.inOrder && step.called?.length) {
    let at = 0;
    for (const n of names) if (n === step.called[at]) at += 1;
    add(`in order: ${step.called.join(' → ')}`, at === step.called.length, `called ${heard}`);
  }
  for (const tool of [...(step.notCalled ?? []), ...(always.notCalled ?? [])])
    add(`never calls ${tool}`, !names.includes(tool), `called ${tool}`);
  for (const m of step.says ?? [])
    add(`says ${m.source}`, m.test(turn.reply), `said "${short(turn.reply)}"`);
  for (const m of [...(step.neverSays ?? []), ...(always.neverSays ?? [])])
    add(`never says ${m.source}`, !m.test(turn.reply), `said "${short(turn.reply)}"`);
  for (const m of step.result ?? [])
    add(
      `a tool answers ${m.source}`,
      turn.calls.some((c) => m.test(c.result)),
      turn.calls.length
        ? `results: ${turn.calls.map((c) => `${c.name}: "${short(c.result, 80)}"`).join('; ')}`
        : 'no tool was called',
    );
  if (step.error !== undefined) {
    const failed = turn.calls.filter((c) => c.isError);
    add(
      step.error ? 'a tool call fails' : 'no tool call fails',
      step.error ? failed.length > 0 : failed.length === 0,
      step.error
        ? 'every call succeeded'
        : failed.map((c) => `${c.name}: "${short(c.result, 80)}"`).join('; '),
    );
  }
  if (step.speakable || always.speakable) {
    const problems = speakableProblems(turn.reply);
    add('speakable', problems.length === 0, problems.join('; '));
  }
  const maxWords = step.maxWords ?? always.maxWords;
  if (maxWords !== undefined) {
    const n = words(turn.reply);
    add(`at most ${maxWords} words`, n <= maxWords, `${n} words`);
  }
  const maxMs = step.maxMs ?? always.maxMs;
  if (maxMs !== undefined)
    add(
      `within ${maxMs} ms`,
      turn.ms <= maxMs,
      `${turn.ms} ms (model ${turn.modelMs}, tools ${turn.toolMs})`,
    );
  return checks;
}

function checkCall(call: ToolCall, expect: Expect): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined || ok ? { name, ok } : { name, ok, detail });
  // A direct call that fails is a failure unless the scenario says it should fail.
  const wantError = expect.error ?? false;
  add(
    wantError ? 'fails' : 'succeeds',
    call.isError === wantError,
    wantError ? `succeeded: "${short(call.result)}"` : `failed: "${short(call.result)}"`,
  );
  for (const m of expect.result ?? [])
    add(`answers ${m.source}`, m.test(call.result), `answered "${short(call.result)}"`);
  if (expect.maxMs !== undefined)
    add(`within ${expect.maxMs} ms`, call.ms <= expect.maxMs, `${call.ms} ms`);
  return checks;
}

function label(step: Step, scenario: Scenario): string {
  const who = (id: string) => scenario.members[id]?.name ?? id;
  switch (step.kind) {
    case 'say':
      return `${who(step.as)}: "${short(step.text, 100)}"`;
    case 'call':
      return `${who(step.as)} calls ${step.tool} ${JSON.stringify(step.args)}`;
    case 'read':
      return `${who(step.as)} reads ${step.uri}`;
    case 'device':
      return `${step.name} → ${step.webhook.method} ${step.webhook.url}`;
    case 'clock':
      return `time moves ${step.to}`;
  }
}

export async function runScenario(scenario: Scenario, opts: RunOptions = {}): Promise<RunReport> {
  const started = Date.now();
  const mode = opts.mode ?? 'live';
  const spec = opts.model ?? scenario.host.model ?? DEFAULT_MODEL;
  const report: RunReport = {
    scenario: scenario.name,
    file: scenario.file,
    model: spec,
    mode,
    ok: false,
    steps: [],
    notes: [],
    ms: 0,
  };
  const cwd = dirname(resolve(scenario.file));
  const url = opts.url ?? scenario.server.url;
  const tape = opts.cassette ?? cassettePath(scenario.file);
  const speaks = scenario.steps.some((s) => s.kind === 'say');

  let server: ServerProcess | undefined;
  const assistants = new Map<string, Assistant>();
  let recorder: Recorder | undefined;
  let player: Player | undefined;

  const finish = (): RunReport => {
    report.ok = !report.error && report.steps.every((s) => s.ok);
    if (!report.ok && server?.log) report.serverLog = server.log;
    report.ms = Date.now() - started;
    return report;
  };

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(scenario.server.env))
      env[k] = resolveValue(v, `server.env.${k}`);

    if (!opts.url && scenario.server.start)
      server = await ServerProcess.start({
        command: scenario.server.start,
        ready: scenario.server.ready ?? url,
        env,
        cwd,
      });

    const tokens = scenario.setup ? await runSetup({ command: scenario.setup, env, cwd }) : {};

    let provider: ModelProvider | undefined;
    if (!speaks) report.model = 'no model';
    else {
      if (mode === 'replay') {
        player = Player.load(tape);
        provider = player;
        report.model = player.spec;
      } else {
        const inner = opts.provider ?? providerFromSpec(spec);
        report.model = inner.spec;
        if (mode === 'record') provider = recorder = new Recorder(inner, scenario.name);
        else provider = inner;
      }
    }
    const cursor = recorder?.cursor ?? player?.cursor;

    const clock = new StoryClock(scenario.clock?.start, scenario.clock?.header);
    const as = async (id: string): Promise<Assistant> => {
      const known = assistants.get(id);
      if (known) return known;
      const member = scenario.members[id]!;
      const token =
        tokens[id] ??
        (member.token ? resolveValue(member.token, `members.${id}.token`) : undefined);
      let a: Assistant;
      try {
        a = await Assistant.connect({ url, name: member.name, token, clock });
      } catch (err) {
        throw new Error(`could not connect to ${url} as ${member.name}: ${(err as Error).message}`);
      }
      assistants.set(id, a);
      return a;
    };

    let stopped = false;
    for (const step of scenario.steps) {
      const base = { index: step.index, kind: step.kind, label: label(step, scenario) };
      if (stopped) {
        report.steps.push({ ...base, ok: true, skipped: true, checks: [], ms: 0 });
        continue;
      }
      const t = Date.now();
      let out: StepReport;
      try {
        switch (step.kind) {
          case 'say': {
            const a = await as(step.as);
            if (cursor) {
              cursor.step = step.index;
              cursor.as = step.as;
            }
            const turn = await a.say(step.text, {
              provider: provider!,
              timezone: scenario.host.timezone,
              prompt: scenario.host.prompt,
              maxSteps: scenario.host.maxSteps,
            });
            const checks = checkSay(turn, step.expect, scenario.always);
            out = {
              ...base,
              ok: checks.every((c) => c.ok),
              checks,
              reply: turn.reply,
              calls: turn.calls,
              modelTurns: turn.modelTurns,
              ms: turn.ms,
            };
            break;
          }
          case 'call': {
            const call = await (await as(step.as)).call(step.tool, step.args);
            const checks = checkCall(call, step.expect);
            out = { ...base, ok: checks.every((c) => c.ok), checks, calls: [call], ms: call.ms };
            break;
          }
          case 'read': {
            const body = await (await as(step.as)).read(step.uri);
            const checks: Check[] = (step.expect.matches ?? []).map((m) =>
              m.test(body)
                ? { name: `matches ${m.source}`, ok: true }
                : { name: `matches ${m.source}`, ok: false, detail: `read "${short(body)}"` },
            );
            out = { ...base, ok: checks.every((c) => c.ok), checks, body, ms: Date.now() - t };
            break;
          }
          case 'device': {
            const res = await sendWebhook(step.webhook, {
              base: url,
              now: clock.now(),
              headers: clock.headers(),
            });
            const want = step.expect.status;
            const ok = want ? want.includes(res.status) : res.status >= 200 && res.status < 300;
            const name = want ? `answers ${want.join(' or ')}` : 'answers 2xx';
            out = {
              ...base,
              ok,
              checks: [
                ok
                  ? { name, ok }
                  : { name, ok, detail: `answered ${res.status}: "${short(res.body)}"` },
              ],
              status: res.status,
              body: res.body,
              ms: res.ms,
            };
            break;
          }
          case 'clock': {
            const now = clock.move(step.to);
            // A new hour is a new conversation, as it would be at home.
            for (const a of assistants.values()) a.forget();
            out = {
              ...base,
              label: `${base.label} → ${spokenTime(now, scenario.host.timezone)}`,
              ok: true,
              checks: [],
              ms: 0,
            };
            break;
          }
        }
      } catch (err) {
        const message =
          err instanceof StaleCassette ? `stale recording: ${err.message}` : (err as Error).message;
        out = { ...base, ok: false, checks: [], error: message, ms: Date.now() - t };
      }
      report.steps.push(out);
      opts.onStep?.(out);
      if (!out.ok && opts.bail) stopped = true;
    }
  } catch (err) {
    report.error =
      err instanceof StaleCassette ? `stale recording: ${err.message}` : (err as Error).message;
  } finally {
    await Promise.all([...assistants.values()].map((a) => a.close()));
    await server?.stop();
  }

  if (recorder) {
    // A failed check is still a true record of what the model did; a step that crashed is not.
    const crashed = report.error ?? report.steps.find((s) => s.error)?.error;
    if (crashed) report.notes.push(`nothing recorded, because the run broke: ${crashed}`);
    else {
      recorder.save(tape);
      report.notes.push(`recorded the model's choices to ${tape}`);
    }
  }
  if (player) {
    report.notes.push(...player.notes);
    if (player.leftover > 0 && report.steps.every((s) => !s.skipped))
      report.notes.push(
        `the recording has ${player.leftover} model turn(s) this run never used; the scenario changed since it was recorded.`,
      );
  }
  return finish();
}
