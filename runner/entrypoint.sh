#!/usr/bin/env bash
# Starts one just-in-time runner: it takes a single job, then exits and the manager removes the
# container. No registration happens here: the manager registered the runner and passes its JIT
# config, so no GitHub credential ever enters this container.
set -euo pipefail

if [[ -z "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ]]; then
  echo "ACTIONS_RUNNER_INPUT_JITCONFIG is missing: this image is started by the manager, not by hand." >&2
  exit 64
fi

# A cache volume mounted on a path the image does not create starts root-owned.
if [[ -n "${RUNNER_CACHE_DIRS:-}" ]]; then
  IFS=: read -ra cache_dirs <<<"$RUNNER_CACHE_DIRS"
  for dir in "${cache_dirs[@]}"; do
    [[ -w "$dir" ]] && continue
    sudo -n chown runner:runner "$dir" 2>/dev/null \
      || echo "warning: cache $dir is not writable (pool without sudo: use a path the image creates)" >&2
  done
fi
unset RUNNER_CACHE_DIRS

# The listener reads the JIT config from ACTIONS_RUNNER_INPUT_JITCONFIG and clears the variable
# before starting a job, so job steps never see it. RUNNER_MANUALLY_TRAP_SIG (set by the base
# image) makes run.sh forward SIGTERM to the listener; this script forwards it to run.sh.
/home/runner/run.sh &
runner_pid=$!
trap 'kill -TERM "$runner_pid" 2>/dev/null || true' TERM INT
wait "$runner_pid" && status=0 || status=$?
# `wait` returns early when a trapped signal arrives: wait again until run.sh is really gone.
while kill -0 "$runner_pid" 2>/dev/null; do
  wait "$runner_pid" && status=0 || status=$?
done

# run.sh exits 0 even when the listener failed (rejected JIT config, runner too old, network):
# "no retry needed". A Worker log only exists once a job ran, so its absence is the real signal,
# and a non-zero exit is what makes the manager back off instead of respawning in a loop.
if ! compgen -G '/home/runner/_diag/Worker_*.log' >/dev/null; then
  echo "runner exited without running a job (run.sh status $status)" >&2
  exit 70
fi
exit "$status"
