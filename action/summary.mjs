// The action's report: each finding or failed step as an annotation on the run, and a
// table in the job summary. Reads the JSON household-sim wrote; changes nothing.
//
//   node action/summary.mjs check|run <report.json>
import { appendFileSync, readFileSync } from 'node:fs';

const [command, file] = process.argv.slice(2);
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  // household-sim stopped before it could report; its own output says why.
  console.log(`::warning title=household-sim::no report to summarise in ${file}`);
  process.exit(0);
}

// Workflow commands end at a new line, and % starts an escape.
const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const annotate = (level, title, message) =>
  console.log(`::${level} title=${escape(title).replace(/[,:]/g, ' ')}::${escape(message)}`);
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

const lines = [];
if (command === 'check') {
  const r = report;
  const name = r.server ? `${r.server.name} ${r.server.version}` : r.url;
  const errors = r.findings.filter((f) => f.level === 'error').length;
  const warnings = r.findings.filter((f) => f.level === 'warn').length;
  for (const f of r.findings) {
    if (f.level === 'error') annotate('error', `household-sim: ${f.where}`, f.message);
    if (f.level === 'warn') annotate('warning', `household-sim: ${f.where}`, f.message);
  }
  lines.push(
    `### household-sim check: ${r.ok ? 'OK' : 'FAIL'}`,
    '',
    `${cell(name)} · protocol ${r.protocolVersion ?? 'unknown'} · ${r.tools ?? 0} tools, ${r.resources ?? 0} resources, ${r.prompts ?? 0} prompts · ${errors} errors, ${warnings} warnings · ${r.ms} ms`,
    '',
  );
  if (r.findings.length) {
    lines.push('| | where | finding |', '|---|---|---|');
    for (const f of r.findings)
      lines.push(`| ${f.level} | ${cell(f.where)} | ${cell(f.message)} |`);
  }
} else {
  const passed = report.filter((r) => r.ok).length;
  lines.push(
    `### household-sim run: ${passed}/${report.length} scenarios passed`,
    '',
    '| | scenario | steps | mode | time |',
    '|---|---|---|---|---|',
  );
  for (const r of report) {
    const ok = r.steps.filter((s) => s.ok).length;
    lines.push(
      `| ${r.ok ? 'PASS' : 'FAIL'} | ${cell(r.scenario)} | ${ok}/${r.steps.length} | ${r.mode} | ${(r.ms / 1000).toFixed(1)} s |`,
    );
    if (r.error) annotate('error', `household-sim: ${r.scenario}`, r.error);
    for (const s of r.steps.filter((s) => !s.ok && !s.skipped)) {
      const why =
        s.error ??
        s.checks
          .filter((c) => !c.ok)
          .map((c) => c.detail ?? c.name)
          .join('; ');
      annotate('error', `household-sim: ${r.scenario}, step ${s.index}`, `${s.label}: ${why}`);
    }
    for (const n of r.notes) annotate('notice', `household-sim: ${r.scenario}`, n);
  }
}

console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
