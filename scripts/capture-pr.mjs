import { capturePr } from './capture-pr-lib.mjs';
import { cliMain, parseArgs } from './pr-cli-common.mjs';

await cliMain(() => capturePr(parseArgs(process.argv.slice(2), ['repository', 'pr', 'output', 'request-timeout-ms', 'timeout-ms', 'max-file-pages'])));
