import test from 'node:test';
import assert from 'node:assert/strict';
import { locateFinding } from '../src/review-planning.mjs';

test('snippet location supports a unique uniform indentation difference only', () => {
  const files = [{ filename: 'a.py', patch: '@@ -3,1 +3,3 @@\n old\n+    if enabled:\n+        run()' }];
  const finding = locateFinding({ file: 'a.py', existing_code: 'if enabled:\n    run()', line: 999 }, files);
  assert.equal(finding.line, 4); assert.equal(finding.location_match, 'uniform_indentation_only');
  assert.equal(locateFinding({ file: 'a.py', existing_code: 'if enabled:\nrun()' }, files).line, null);
  assert.equal(locateFinding({ file: 'a.py', existing_code: 'if  enabled:\n    run()' }, files).line, null);
});

test('indentation fallback never guesses repeated or removed-only source', () => {
  const repeat = [{ filename: 'a.py', patch: '@@ -1 +1,2 @@\n-x\n+    run()\n+        run()' }];
  assert.equal(locateFinding({ file: 'a.py', existing_code: 'run()' }, repeat).location_status, 'ambiguous');
  const removed = [{ filename: 'a.py', patch: '@@ -1 +1 @@\n-    run()\n+    stop()' }];
  assert.equal(locateFinding({ file: 'a.py', existing_code: 'run()' }, removed).line, null);
});
