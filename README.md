# AI Review

This repository contains a source snapshot of the `github-ai-reviewer` service that was running on 2026-09-29. The source was exported from production container image `sha256:b06ff5f67d17628178d363b91a0bb0dc94f7390588167a68ac79100cf0aea684`.

The snapshot contains the image's `src/`, `public/`, `scripts/`, `package.json`, and `package-lock.json`. It does **not** include the un-deployed dashboard candidate, `node_modules`, runtime job state, logs, `.env`, API credentials, or GitHub App private keys. This is a source snapshot, not a complete production backup or a deployment configuration.

Install dependencies with `npm ci`. Runtime configuration and secrets must be supplied separately; do not commit them to this public repository.
