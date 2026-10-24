#!/usr/bin/env bash
# Checks, inside the runner image and as its `runner` user, what every job relies on. Run by CI on
# each build: both failures it guards against broke every job (a root-owned `_work`, and no real
# `node`, which made `bun run` execute Node tools under Bun).
#
#   docker run --rm --entrypoint bash -v "$PWD/runner/smoke-test.sh:/smoke-test.sh:ro" <image> /smoke-test.sh
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "$(id -un)" == runner ]] || fail "runs as $(id -un), not runner"

# The runner creates _work/_temp and the job's workspace; setup-* actions install under $HOME.
for dir in /home/runner/_work /home/runner/_work/_tool /home/runner/.bun /home/runner/.bun/install \
  /home/runner/.bun/install/cache /home/runner/.cache /home/runner/.npm; do
  owner="$(stat -c %U "$dir")" || fail "$dir is missing"
  [[ "$owner" == runner ]] || fail "$dir is owned by $owner, not runner"
done
for dir in /home/runner/_work/_temp /home/runner/_work/repo/repo /home/runner/.bun/bin /home/runner/.config; do
  mkdir -p "$dir" || fail "cannot create $dir"
  touch "$dir/.probe" || fail "cannot write to $dir"
done

runtime=$(node -p "process.versions.bun ? 'bun' : 'node'") || fail "no node on PATH"
[[ "$runtime" == node ]] || fail "node on PATH is $runtime, not Node.js"
npm --version >/dev/null || fail "no npm"

for tool in gh git curl jq unzip zip xz zstd rsync python3 gcc make; do
  command -v "$tool" >/dev/null || fail "$tool is missing"
done
sudo -n true || fail "passwordless sudo is missing"

echo "OK: node $(node --version), npm $(npm --version), $(git --version), $(python3 --version), $(gh --version | head -1)"
