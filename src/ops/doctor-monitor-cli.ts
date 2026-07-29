import { CommandLedger } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  DOCTOR_MONITOR_EXIT,
  renderDoctorMonitor,
  runDoctorMonitor,
  type DoctorMonitorRequest,
} from './doctor-monitor.js';
import { isDirectRun } from './direct-run.js';

// Phase 278 — `npm run ops:doctor-monitor`.
//
// A SCHEDULE'S TWO MISSING PIECES, AND NOTHING ELSE. It runs the shipped read-only `ops:doctor --json`, keeps
// a redacted state file between runs, counts consecutive non-healthy runs, and exits with a distinct code per
// state. It sends no alert and contacts nothing: the scheduler that runs it is what alerts, from an exit code
// it already has.

function usage(): string {
  return [
    'usage: npm run ops:doctor-monitor -- --project <dir> --state <rel> [--service <name>] [--json]',
    '',
    'Runs the shipped read-only doctor inside your stack and records one redacted state file.',
    '',
    'required:',
    '  --project <dir>   the Compose project directory, absolute',
    '  --state <rel>     an existing directory for the state file, relative to the project',
    '',
    'options:',
    '  --service <name>  the Compose service to run the doctor in (default: app)',
    '  --json            print the machine-readable state instead of the summary',
    '',
    'It writes ONE file and contacts nothing. No alert is sent — your scheduler alerts from the exit code.',
    'It never softens the doctor: a WARN stays a WARN and a FAIL stays a FAIL.',
    '',
    `exit codes: ${DOCTOR_MONITOR_EXIT.HEALTHY} healthy | ${DOCTOR_MONITOR_EXIT.FAIL} a check FAILED `
      + `| ${DOCTOR_MONITOR_EXIT.USAGE} bad usage | ${DOCTOR_MONITOR_EXIT.WARN} a check WARNED `
      + `| ${DOCTOR_MONITOR_EXIT.INVALID} the doctor could not be read`,
  ].join('\n');
}

export function parseDoctorMonitorArgs(argv: readonly string[]): { readonly request: DoctorMonitorRequest; readonly json: boolean } {
  const parsed = parseMaintenanceFlags(argv, { values: ['project', 'state', 'service'], switches: ['json'] });
  const project = parsed.values.project;
  const state = parsed.values.state;
  if (project === undefined) throw new MaintenanceUsageError('--project is required');
  if (state === undefined) throw new MaintenanceUsageError('--state is required');
  return {
    request: {
      projectRoot: project,
      stateDir: state,
      ...(parsed.values.service === undefined ? {} : { service: parsed.values.service }),
    },
    json: parsed.switches.has('json'),
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return DOCTOR_MONITOR_EXIT.HEALTHY; }
  let args: ReturnType<typeof parseDoctorMonitorArgs>;
  try {
    args = parseDoctorMonitorArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return DOCTOR_MONITOR_EXIT.USAGE;
  }
  try {
    const report = runDoctorMonitor(args.request, { runner: realCommandRunner(), ledger: new CommandLedger() });
    console.log(args.json ? JSON.stringify(report, null, 2) : renderDoctorMonitor(report));
    return report.exitCode;
  } catch (err) {
    // A MONITOR THAT CANNOT RUN IS NOT A HEALTHY MONITOR. Its own failure exits INVALID, distinctly, so a
    // scheduler can tell "the installation is unwell" from "the check is broken".
    console.error(reportRefusal(err));
    return DOCTOR_MONITOR_EXIT.INVALID;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
