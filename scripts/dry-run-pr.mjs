import { dryRunPr } from './dry-run-pr-lib.mjs';
import { cliMain, parseArgs } from './pr-cli-common.mjs';

await cliMain(() => dryRunPr(parseArgs(process.argv.slice(2), ['repo', 'skill', 'fixture', 'output', 'mode', 'model-window-ms', 'python'])));
