/**
 * Keeps every pool of `runners.yml` at its count of idle-or-busy runners, one fresh container per
 * job.
 *
 * Each tick:
 *   1. reap   containers that stopped (job done, crash): log a failure, remove the container,
 *             delete its runner registration (usually already gone: JIT runners are ephemeral).
 *   2. spawn  register a JIT runner, then create and start its container.
 *   3. excess stop idle runners beyond their pool's count (count lowered, pool removed): the
 *             registration is deleted first, which GitHub refuses on a busy runner, so a running
 *             job is never cut. A busy excess runner is left to exit after its job, checked once.
 *   4. gc     every GC_MINUTES, delete offline registrations of this prefix that no container
 *             backs (left by a host crash or a `docker rm -f`).
 * `runners.yml` is re-read on every tick: an edit applies within TICK_SECONDS. An invalid edit is
 * logged and the last valid config kept.
 *
 * SIGTERM drains: idle runners go at once, busy ones get DRAIN_SECONDS to finish their job.
 *
 * Env: RUNNER_NAME_PREFIX (required, [a-z0-9], unique per host: GC only touches its own runners),
 *      CONFIG_FILE (/etc/gha/runners.yml), RUNNER_IMAGE (gha-runner:local), TICK_SECONDS (10),
 *      GC_MINUTES (10), DRAIN_SECONDS (300), credentials: see github.ts.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { type Config, ConfigError, loadConfig, type Pool } from './config';
import { docker } from './docker';
import { GitHub, type Runner } from './github';
import { containerSpec, idleToStop, LABEL, type Managed, networkName, plan, runnerLabels } from './plan';

const PREFIX = process.env.RUNNER_NAME_PREFIX ?? '';
const CONFIG_FILE = process.env.CONFIG_FILE ?? '/etc/gha/runners.yml';
const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'gha-runner:local';
const TICK_MS = Number(process.env.TICK_SECONDS ?? 10) * 1_000;
const GC_MS = Number(process.env.GC_MINUTES ?? 10) * 60_000;
const DRAIN_MS = Number(process.env.DRAIN_SECONDS ?? 300) * 1_000;
const HEARTBEAT_FILE = '/tmp/heartbeat';
/** A runner that exits non-zero sooner than this after starting is crash-looping, not working. */
const CRASH_WINDOW_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Per pool and tick: `generate-jitconfig` answers 422 when hammered. */
const MAX_SPAWN_PER_TICK = 5;

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

if (!/^[a-z0-9]{1,20}$/.test(PREFIX)) {
  // No dash: the GC matches `<prefix>-`, and a dash would let one host's prefix cover another's.
  log('error', 'RUNNER_NAME_PREFIX is required: [a-z0-9], 20 chars max, unique per host');
  process.exit(1);
}

const github = new GitHub();
const host = await docker.info();
const backoff = new Map<string, { until: number; delayMs: number }>();
/** Runner ids GitHub reported busy: they stay busy until their container exits. */
const knownBusy = new Set<number>();
let config: Config = { pools: [] };
let lastConfigError = '';
let lastGc = 0;
let stopping = false;

function reloadConfig(): void {
  let next: Config;
  try {
    next = loadConfig(CONFIG_FILE, RUNNER_IMAGE);
    for (const pool of next.pools) github.assertCredentials(pool.org);
    for (const runtime of new Set(next.pools.flatMap((p) => (p.runtime ? [p.runtime] : [])))) {
      if (!(runtime in host.Runtimes)) throw new Error(`runtime "${runtime}" is not registered in the Docker daemon`);
    }
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `config: ${(error as Error).message}`;
    if (message !== lastConfigError) log('error', `${message}\n  keeping the previous config`);
    lastConfigError = message;
    return;
  }
  lastConfigError = '';
  const before = JSON.stringify(config);
  config = next;
  if (JSON.stringify(next) === before) return;

  const summary = next.pools.map((p) => `${p.name}(${p.org})=${p.count}`).join(', ') || 'none';
  log('info', `config loaded: ${summary}`);
  const cpus = next.pools.reduce((sum, p) => sum + p.count * p.cpus, 0);
  const memory = next.pools.reduce((sum, p) => sum + p.count * p.memory, 0);
  if (cpus > host.NCPU) log('warn', `pools reserve ${cpus} CPUs, the host has ${host.NCPU}: busy runners will contend`);
  if (memory > host.MemTotal) {
    const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    log('warn', `pools reserve ${gib(memory)} GiB of memory, the host has ${gib(host.MemTotal)} GiB: expect OOM kills`);
  }
}

function penalize(pool: string, reason: string): void {
  const current = backoff.get(pool);
  // Several runners of a pool failing in the same window are one failure, not a doubling each.
  if (current && current.until > Date.now()) {
    log('warn', `pool ${pool}: ${reason}`);
    return;
  }
  const delayMs = Math.min((current?.delayMs ?? 7_500) * 2, MAX_BACKOFF_MS);
  backoff.set(pool, { until: Date.now() + delayMs, delayMs });
  log('warn', `pool ${pool}: ${reason}; next spawn in ${Math.round(delayMs / 1000)}s`);
}

async function listManaged(): Promise<Managed[]> {
  const containers = await docker.listContainers(`${LABEL.manager}=${PREFIX}`);
  return containers.map((c) => ({
    id: c.Id,
    name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
    state: c.State,
    pool: c.Labels[LABEL.pool] ?? '',
    org: c.Labels[LABEL.org] ?? '',
    runnerId: Number(c.Labels[LABEL.runnerId]),
  }));
}

async function deregister(c: Managed): Promise<void> {
  if (!c.org || !Number.isInteger(c.runnerId)) return;
  try {
    const result = await github.deleteRunner(c.org, c.runnerId);
    if (result === 'deleted') log('info', `${c.name}: registration deleted`);
  } catch (error) {
    // The GC catches it on a later pass.
    log('warn', `${c.name}: could not delete registration ${c.runnerId}: ${(error as Error).message}`);
  }
}

async function reap(c: Managed): Promise<void> {
  try {
    const state = await docker.inspectState(c.id);
    const ranMs = Date.parse(state.FinishedAt) - Date.parse(state.StartedAt);
    if (state.OOMKilled || state.ExitCode !== 0) {
      const tail = await docker.logTail(c.id, 20);
      const why = state.OOMKilled ? 'OOM-killed (raise the pool memory)' : `exited ${state.ExitCode}`;
      log('warn', `${c.name}: ${why} after ${Math.round(ranMs / 1000)}s${tail ? `\n${tail}` : ''}`);
      // A container that never started (state `created`) has no valid StartedAt: also a crash.
      if (!(ranMs >= CRASH_WINDOW_MS)) penalize(c.pool, `runner ${c.name} died at startup`);
    } else {
      log('info', `${c.name}: job done, container removed`);
      backoff.delete(c.pool);
    }
  } catch (error) {
    log('warn', `${c.name}: inspect failed: ${(error as Error).message}`);
  }
  await docker.remove(c.id);
  await deregister(c);
  knownBusy.delete(c.runnerId);
}

async function spawn(pool: Pool): Promise<void> {
  if (!(await docker.imageExists(pool.image))) {
    penalize(pool.name, `image ${pool.image} is missing (docker compose build)`);
    return;
  }
  await docker.ensureNetwork(networkName(PREFIX, pool.name), { [LABEL.manager]: PREFIX, [LABEL.pool]: pool.name });

  const name = `${PREFIX}-${pool.name}-${randomBytes(3).toString('hex')}`;
  let runnerId: number;
  let jitConfig: string;
  try {
    const groupId = await github.runnerGroupId(pool.org, pool.group);
    ({ runnerId, jitConfig } = await github.createJitRunner(pool.org, name, groupId, runnerLabels(pool, host.Architecture)));
  } catch (error) {
    penalize(pool.name, `registration failed: ${(error as Error).message}`);
    return;
  }

  try {
    const id = await docker.create(name, containerSpec({ prefix: PREFIX, pool, name, runnerId, jitConfig }));
    await docker.start(id);
    log('info', `${name}: started for ${pool.org} (runner ${runnerId})`);
  } catch (error) {
    // Never leave a registration without a container behind it.
    await docker.remove(name).catch(() => {});
    await github.deleteRunner(pool.org, runnerId).catch(() => {});
    penalize(pool.name, `container start failed: ${(error as Error).message}`);
  }
}

/** Stops up to `count` idle runners among `candidates`. Returns how many were stopped. */
async function stopIdle(org: string, count: number, candidates: Managed[]): Promise<number> {
  // A JIT runner seen busy never turns idle again: it exits after its job. Only the others need a
  // look, so a long job on an excess runner costs one API call, not one per tick.
  const unchecked = candidates.filter((c) => !knownBusy.has(c.runnerId));
  if (unchecked.length === 0) return 0;
  let runners: Runner[];
  try {
    runners = await github.listRunners(org);
  } catch (error) {
    log('warn', `scale down in ${org}: could not list runners: ${(error as Error).message}`);
    return 0;
  }
  for (const runner of runners) if (runner.busy) knownBusy.add(runner.id);

  let stopped = 0;
  for (const c of idleToStop(unchecked, runners, count)) {
    let result: Awaited<ReturnType<GitHub['deleteRunner']>>;
    try {
      // Still the safety net: GitHub refuses (busy) a job assigned since the list.
      result = await github.deleteRunner(org, c.runnerId);
    } catch (error) {
      log('warn', `${c.name}: could not delete registration: ${(error as Error).message}`);
      continue;
    }
    if (result === 'busy') {
      knownBusy.add(c.runnerId);
      continue;
    }
    await docker.stop(c.id, 10);
    await docker.remove(c.id);
    log('info', `${c.name}: idle runner stopped (${result === 'deleted' ? 'registration deleted' : 'already unregistered'})`);
    stopped++;
  }
  return stopped;
}

async function collectGarbage(containers: Managed[]): Promise<void> {
  const backed = new Set(containers.map((c) => c.runnerId));
  const orgs = new Set([...config.pools.map((p) => p.org), ...containers.map((c) => c.org).filter(Boolean)]);
  for (const org of orgs) {
    try {
      for (const runner of await github.listRunners(org)) {
        if (!runner.name.startsWith(`${PREFIX}-`) || backed.has(runner.id) || runner.status !== 'offline') continue;
        if ((await github.deleteRunner(org, runner.id)) === 'deleted') {
          log('info', `gc: deleted orphan registration ${runner.name} in ${org}`);
        }
      }
    } catch (error) {
      log('warn', `gc: ${org}: ${(error as Error).message}`);
    }
  }
}

async function tick(): Promise<void> {
  reloadConfig();
  const decided = plan(config.pools, await listManaged());

  for (const c of decided.reap) await reap(c);

  for (const { org, count, candidates } of decided.excess) await stopIdle(org, count, candidates);

  for (const { pool, count } of decided.spawn) {
    for (let i = 0; i < Math.min(count, MAX_SPAWN_PER_TICK) && !stopping; i++) {
      // Re-read each time: a failed spawn just above sets the backoff.
      if ((backoff.get(pool.name)?.until ?? 0) > Date.now()) break;
      await spawn(pool);
    }
  }

  if (Date.now() - lastGc > GC_MS) {
    lastGc = Date.now();
    // Fresh list: the spawns above created registrations the GC must see as backed.
    await collectGarbage(await listManaged());
  }
}

async function drain(): Promise<void> {
  const deadline = Date.now() + DRAIN_MS;
  log('info', `draining: idle runners stop now, busy ones have ${DRAIN_MS / 1000}s`);
  for (;;) {
    const containers = await listManaged();
    for (const c of containers.filter((c) => c.state !== 'running' && c.state !== 'removing')) await reap(c);
    const alive = containers.filter((c) => c.state === 'running');
    if (alive.length === 0) break;
    for (const [org, members] of Map.groupBy(alive, (c) => c.org)) await stopIdle(org, members.length, members);
    if (Date.now() > deadline) {
      for (const c of alive) {
        log('warn', `${c.name}: drain timeout, stopping it mid-job`);
        await docker.stop(c.id, 10);
        await docker.remove(c.id);
        await deregister(c);
      }
      break;
    }
    await Bun.sleep(5_000);
  }
  log('info', 'drained');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log('info', `${signal} received`);
  });
}

log('info', `manager ${PREFIX} on ${host.Architecture}, ${host.NCPU} CPUs, ${(host.MemTotal / 1024 ** 3).toFixed(1)} GiB`);
while (!stopping) {
  try {
    await tick();
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch (error) {
    log('error', `tick failed: ${(error as Error).stack ?? error}`);
  }
  const wakeAt = Date.now() + TICK_MS;
  while (!stopping && Date.now() < wakeAt) await Bun.sleep(500);
}
await drain();
process.exit(0);
