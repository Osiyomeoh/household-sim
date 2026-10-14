#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkServer, type Finding } from './check.js';
import { DEFAULT_MODEL, cassettePath } from './providers/index.js';
import { bold, dim, formatStep, formatSummary, green, junit, red, yellow } from './report.js';
import { runScenario, type Mode, type RunReport } from './run.js';
import { ScenarioError, loadScenario, resolveValue } from './scenario.js';

const HELP = `household-sim: test an MCP server the way a household would use it.

Usage:
  household-sim check <url> [--token T] [--min-protocol 2025-06-18] [--json]
      Connect, read the tools, and report what a voice host and its model would trip on.

  household-sim run <scenario.yaml>... [options]
      Play each scenario: people speak, devices fire, time moves, and every step is checked.

Run options:
  --model <spec>      the model that plays the assistant (default ${DEFAULT_MODEL})
                      bedrock:<model id> | openai:<model> | ollama:<model>
  --record            run the model and save its choices beside each scenario
  --replay            replay saved choices: no model, no credentials, no cost
  --cassettes <dir>   where recordings live (default: cassettes/ beside each scenario)
  --url <url>         a server that is already running (the scenario's start command is skipped)
  --bail              stop a scenario at its first failed step
  --junit <file>      also write JUnit XML, for CI
  --json <file>       also write the full results as JSON

Values written env:NAME (tokens, secrets) are read from the environment.
Exit status: 0 all passed, 1 something failed, 2 the command or a scenario is wrong.`;

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      token: { type: 'string' },
      'min-protocol': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error(
      'check: give the MCP endpoint, e.g. household-sim check http://localhost:8790/mcp',
    );
    return 2;
  }
  const r = await checkServer(target, {
    token: values.token ? resolveValue(values.token, '--token') : undefined,
    minProtocol: values['min-protocol'],
  });
  if (values.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  const head = [
    r.server ? `${r.server.name} ${r.server.version}` : r.url,
    r.protocolVersion && `protocol ${r.protocolVersion}`,
    r.status !== undefined && r.status !== 200 && `HTTP ${r.status}`,
    `${r.tools} tools, ${r.resources} resources, ${r.prompts} prompts`,
  ].filter(Boolean);
  console.log(bold(head.join(' · ')));
  const mark: Record<Finding['level'], string> = {
    error: red('✗'),
    warn: yellow('!'),
    info: dim('·'),
  };
  for (const level of ['error', 'warn', 'info'] as const)
    for (const f of r.findings.filter((x) => x.level === level))
      console.log(`${mark[level]} ${f.where}: ${level === 'info' ? dim(f.message) : f.message}`);
  const count = (l: Finding['level']) => r.findings.filter((f) => f.level === l).length;
  console.log(
    `${r.ok ? green(bold('OK')) : red(bold('FAIL'))} ${count('error')} errors, ${count('warn')} warnings · ${r.ms} ms`,
  );
  return r.ok ? 0 : 1;
}

async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      record: { type: 'boolean' },
      replay: { type: 'boolean' },
      cassettes: { type: 'string' },
      url: { type: 'string' },
      bail: { type: 'boolean' },
      junit: { type: 'string' },
      json: { type: 'string' },
    },
  });
  if (!positionals.length) {
    console.error('run: give one or more scenario files');
    return 2;
  }
  if (values.record && values.replay) {
    console.error('run: --record and --replay cannot be used together');
    return 2;
  }
  const mode: Mode = values.record ? 'record' : values.replay ? 'replay' : 'live';
  // Load every file first, so a typo in the last one is found before the first one runs.
  const scenarios = positionals.map((f) => loadScenario(f));
  const reports: RunReport[] = [];
  for (const s of scenarios) {
    console.log(bold(`\n${s.name}`) + dim(`  ${s.file}`));
    const r = await runScenario(s, {
      mode,
      bail: values.bail ?? false,
      ...(values.model ? { model: values.model } : {}),
      ...(values.url ? { url: values.url } : {}),
      ...(values.cassettes ? { cassette: cassettePath(s.file, values.cassettes) } : {}),
      onStep: (step) => console.log(formatStep(step)),
    });
    console.log(formatSummary(r));
    reports.push(r);
  }
  if (reports.length > 1) {
    const passed = reports.filter((r) => r.ok).length;
    console.log(bold(`\n${passed}/${reports.length} scenarios passed`));
  }
  if (values.junit) writeFileSync(values.junit, junit(reports));
  if (values.json) writeFileSync(values.json, JSON.stringify(reports, null, 2) + '\n');
  return reports.every((r) => r.ok) ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'check':
        return await check(rest);
      case 'run':
        return await run(rest);
      case '--version':
      case '-v':
        console.log('0.1.0');
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return command === undefined ? 2 : 0;
      default:
        console.error(`unknown command "${command}"\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (
      err instanceof ScenarioError ||
      (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      console.error(red((err as Error).message));
      return 2;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
