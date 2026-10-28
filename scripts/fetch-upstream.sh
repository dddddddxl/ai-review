#!/usr/bin/env bash
# Fetch upstream framework sources for plugin repositories and write the
# AI_UPSTREAM_CONFIG file that maps (repository, base branch) to them.
#
#   scripts/fetch-upstream.sh /srv/ai-review/upstream
#   AI_UPSTREAM_CONFIG=/srv/ai-review/upstream/upstream.json
#
# Repositories that vendor their upstream as git submodules (Megatron-LM-das,
# verl-das) need nothing here: the review fetches submodules at their pinned
# commits. Framework forks (pytorch-das, sglang-das, …) contain the upstream.
#
# Upstream sources are not pinned to a PR's commit. Versions follow the plugin's
# declared dependency; where the exact release is not public the closest tag is
# used and noted below. Re-run after adding a plugin branch.
set -euo pipefail
dest=${1:?usage: fetch-upstream.sh DEST_DIR}
mkdir -p "$dest"

# repository|base-branch regex|upstream GitHub repo|tag|python package|note
SOURCES=$(cat <<'EOF'
HYGON-AI/vllm-plugin-das|^v0\.28\.1|vllm-project/vllm|v0.28.1rc0|vllm|plugin Dockerfile pins vllm==0.28.1 (HCU build); closest public tag
HYGON-AI/vllm-plugin-das|^release_dsv41|vllm-project/vllm|v0.28.1rc0|vllm|release branch cut from v0.28.1-dev
HYGON-AI/vllm-plugin-das|^v0\.25\.1|vllm-project/vllm|v0.25.1|vllm|README states vLLM 0.25.1
HYGON-AI/LMCache-das|^v0\.3\.13|LMCache/LMCache|v0.3.13|lmcache|pyproject pins LMCache 0.3.13
HYGON-AI/LMCache-das|.*|LMCache/LMCache|v0.4.2|lmcache|pyproject pins LMCache 0.4.2 on main
HYGON-AI/slime-das|.*|THUDM/slime|v0.3.2|slime|v0.3.2 branch; main has no pin, same tag used
EOF
)

config="$dest/upstream.json"
rows=()
while IFS='|' read -r repository branch upstream tag package note; do
  dir="$dest/${upstream//\//__}-$tag"
  if [ ! -d "$dir/$package" ]; then
    echo "fetch $upstream@$tag -> $dir"
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 "https://codeload.github.com/$upstream/tar.gz/refs/tags/$tag" | tar -xz -C "$tmp" --strip-components=1
    rm -rf "$dir" && mv "$tmp" "$dir"
    chmod -R a-w "$dir"
  fi
  [ -d "$dir/$package" ] || { echo "missing package $package in $upstream@$tag" >&2; exit 1; }
  rows+=("$repository|$branch|$package|$dir/$package|$upstream@$tag|$note")
done <<<"$SOURCES"

py=python3; "$py" -c '' 2>/dev/null || py=python
printf '%s\n' "${rows[@]}" | "$py" -c '
import json, sys
rows = [line.rstrip("\r\n").split("|") for line in sys.stdin if line.strip()]
print(json.dumps([{"repository": r, "baseRef": b, "sources": {p: d}, "upstream": u, "note": n} for r, b, p, d, u, n in rows], indent=1))
' > "$config"
echo "wrote $config"
