import assert from 'node:assert/strict';
import {createModelClient} from '../src/model-client.mjs';
import {generateCiEvidence} from '../src/ci-analysis.mjs';
const evidenceLog='L1: 2026-09-14T02:00:00.0000000Z ERROR: test_accuracy (SyntheticTest)\nL2: 2026-09-14T02:00:00.0000000Z Traceback (most recent call last):\nL3: 2026-09-14T02:00:00.0000000Z   File "synthetic_test.py", line 10, in test_accuracy\nL4: 2026-09-14T02:00:00.0000000Z AssertionError: 0.50 not greater than or equal to 0.64';
const result=await generateCiEvidence(createModelClient(),{input:`Synthetic CI compatibility test. No real repository data.\n<logs>\n${evidenceLog}\n</logs>\n<diff>\n</diff>`,evidenceLog,log:console.log,context:{probe:'synthetic-ci'}});
assert.equal(result.kind,'direct');assert(result.evidence.some(q=>q.includes('AssertionError')));assert(result.evidence.every(q=>q.includes('2026-09-14T02:00:00.0000000Z')));
console.log(JSON.stringify({probe:'synthetic-ci',passed:true,kind:result.kind,evidenceCount:result.evidence.length}));
