# AI Review

This repository contains the `github-ai-reviewer` service source. The current code includes CI recovery fixes and the bounded-evidence review engine RC1.1.

## Version status

- CI recovery fixes distinguish scan execution failures from confirmed code issues, and replace obsolete failure messages after a successful rerun. These fixes were deployed separately on 2026-10-21.
- RC1.1 uses complete-file review units, read-only repository evidence tools, independent verification, durable candidate checkpoints, and shared concurrency/accounting/deadline controls. It is a release candidate, **not an end-to-end quality-approved production release**.
- The candidate service defaults to `AI_PR_REVIEW_ENGINE=evidence-v1`. Set `AI_PR_REVIEW_ENGINE=legacy` explicitly to select the previous review path; there is no automatic fallback.
- Publishing this source does not change the running production service or its model/API/concurrency configuration.

## Install and test

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The frozen RC1.1 candidate passed 81 offline regressions. These tests do not call a model. Real GLM verification controls rejected two unsupported candidates and confirmed one argument-contract defect; they do not establish whole-PR generation recall, precision or throughput. See [validation and limitations](docs/RELEASE-RC1.1.txt).

Runtime configuration and secrets must be supplied separately. The repository must not contain `node_modules`, job state, model-run outputs, logs, `.env`, API credentials, GitHub App keys or private deployment backups. It is source code, not a full production backup or a deployment configuration.

See [operations](REVIEW-QUALITY-OPERATIONS.txt) before replay or deployment. Whole-PR quality, latency/memory/throughput and deployment preflight remain required.

## Original snapshot provenance

The original main commit `9d8ed7143027c13b2c869fb9d30587b581ecf535` published the production source snapshot from 2026-09-29, exported from image `sha256:b06ff5f67d17628178d363b91a0bb0dc94f7390588167a68ac79100cf0aea684`. Its history is retained. The present candidate is a modified version of that snapshot.

Do not commit credentials or private operational data to this public repository.
