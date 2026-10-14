import type { RunReport, StepReport } from './run.js';

/** A run, written for a person at a terminal, for CI as JUnit XML, or as JSON. */

const tty = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const dim = paint(2);
export const bold = paint(1);

export function formatStep(s: StepReport): string {
  const mark = s.skipped ? dim('-') : s.ok ? green('✓') : red('✗');
  const lines = [
    `${mark} ${String(s.index).padStart(2)}  ${s.label}${s.skipped ? dim(' (skipped)') : ''}`,
  ];
  const pad = '       ';
  if (s.reply !== undefined) {
    const tools = s.calls?.length
      ? s.calls.map((c) => (c.isError ? `${c.name}!` : c.name)).join(', ')
      : 'no tools';
    lines.push(`${pad}${dim(`[${tools}]`)} ${s.reply.replace(/\s+/g, ' ').trim()}`);
  }
  if (s.error) lines.push(`${pad}${red(s.error)}`);
  for (const c of s.checks)
    if (!c.ok) lines.push(`${pad}${red('✗')} ${c.name}${c.detail ? dim(` - ${c.detail}`) : ''}`);
  return lines.join('\n');
}

export function formatSummary(r: RunReport): string {
  const ran = r.steps.filter((s) => !s.skipped);
  const passed = ran.filter((s) => s.ok).length;
  const lines: string[] = [];
  if (r.error) lines.push(red(`  could not run: ${r.error}`));
  for (const n of r.notes) lines.push(yellow(`  note: ${n}`));
  if (r.serverLog)
    lines.push(
      dim(
        `  server output (last lines):\n${indent(r.serverLog.split('\n').slice(-15).join('\n'), 4)}`,
      ),
    );
  const verdict = r.ok ? green(bold('PASS')) : red(bold('FAIL'));
  lines.push(
    `${verdict} ${r.scenario}: ${passed}/${r.steps.length} steps · ${r.model} · ${(r.ms / 1000).toFixed(1)}s`,
  );
  return lines.join('\n');
}

const indent = (s: string, n: number) => s.replace(/^/gm, ' '.repeat(n));

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 has no way to carry most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** One test suite per scenario and one test case per step, which most CI systems display. */
export function junit(reports: RunReport[]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = reports.reduce((n, r) => n + Math.max(r.steps.length, 1), 0);
  const failures = reports.reduce(
    (n, r) => n + (r.error && !r.steps.length ? 1 : r.steps.filter((s) => !s.ok).length),
    0,
  );
  out.push(`<testsuites name="household-sim" tests="${total}" failures="${failures}">`);
  for (const r of reports) {
    const failed = r.steps.filter((s) => !s.ok).length;
    const skipped = r.steps.filter((s) => s.skipped).length;
    out.push(
      `  <testsuite name="${xml(r.scenario)}" file="${xml(r.file)}" tests="${Math.max(r.steps.length, 1)}" failures="${r.error && !r.steps.length ? 1 : failed}" skipped="${skipped}" time="${(r.ms / 1000).toFixed(3)}">`,
    );
    out.push(
      `    <properties><property name="model" value="${xml(r.model)}"/><property name="mode" value="${r.mode}"/></properties>`,
    );
    if (r.error && !r.steps.length)
      out.push(
        `    <testcase name="start" classname="${xml(r.scenario)}"><failure message="${xml(r.error)}"/></testcase>`,
      );
    for (const s of r.steps) {
      const name = `${String(s.index).padStart(2, '0')} ${s.label}`;
      const open = `    <testcase name="${xml(name)}" classname="${xml(r.scenario)}" time="${(s.ms / 1000).toFixed(3)}"`;
      if (s.skipped) {
        out.push(`${open}><skipped/></testcase>`);
      } else if (!s.ok) {
        const why =
          s.error ??
          s.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.name}${c.detail ? ` - ${c.detail}` : ''}`)
            .join('\n');
        const reply = s.reply !== undefined ? `\nreply: ${s.reply}` : '';
        out.push(
          `${open}><failure message="${xml(why.split('\n')[0] ?? '')}">${xml(why + reply)}</failure></testcase>`,
        );
      } else {
        out.push(`${open}/>`);
      }
    }
    if (r.notes.length) out.push(`    <system-out>${xml(r.notes.join('\n'))}</system-out>`);
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return out.join('\n') + '\n';
}
