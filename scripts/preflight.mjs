import {releasePreflight} from '../src/release-preflight.mjs';
const report=releasePreflight();
console.log(JSON.stringify(report,null,2));
if(!report.configurationReady)process.exitCode=2;
