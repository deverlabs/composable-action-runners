/**
 * Pure decisions of the reconcile loop, kept apart from the I/O so they can be tested:
 * what to reap, what to spawn, what is in excess, and the container a runner gets.
 */

import type { Pool } from './config';

export const LABEL = {
  manager: 'gha.manager',
  pool: 'gha.pool',
  org: 'gha.org',
  runnerId: 'gha.runner-id',
} as const;

export interface Managed {
  id: string;
  name: string;
  state: string;
  pool: string;
  org: string;
  runnerId: number;
}

export interface Plan {
  /** Containers that are not running any more (job done, crash, never started): remove them. */
  reap: Managed[];
  spawn: { pool: Pool; count: number }[];
  /** Running containers beyond what their pool wants; only the idle ones may be stopped. */
  excess: { org: string; count: number; candidates: Managed[] }[];
}

export function plan(pools: Pool[], containers: Managed[]): Plan {
  const reap = containers.filter((c) => c.state !== 'running' && c.state !== 'removing');
  const alive = containers.filter((c) => c.state === 'running');

  const spawn: Plan['spawn'] = [];
  const excess: Plan['excess'] = [];
  const wanted = new Map(pools.map((p) => [p.name, p]));

  for (const pool of pools) {
    // A container registered for another org than its pool now names is excess, not capacity.
    const members = alive.filter((c) => c.pool === pool.name && c.org === pool.org);
    if (members.length < pool.count) spawn.push({ pool, count: pool.count - members.length });
    if (members.length > pool.count) {
      excess.push({ org: pool.org, count: members.length - pool.count, candidates: members });
    }
  }

  const orphans = alive.filter((c) => wanted.get(c.pool)?.org !== c.org);
  const byOrg = Map.groupBy(orphans, (c) => c.org);
  for (const [org, candidates] of byOrg) excess.push({ org, count: candidates.length, candidates });

  return { reap, spawn, excess };
}

/**
 * The excess runners that may be stopped: those GitHub lists as not busy, up to `count`. A runner
 * GitHub no longer lists is ending its job (an ephemeral runner leaves the list with it) and exits
 * on its own, like a busy one: neither is stopped.
 */
export function idleToStop(
  candidates: Managed[],
  runners: { id: number; busy: boolean }[],
  count: number,
): Managed[] {
  const busy = new Map(runners.map((r) => [r.id, r.busy]));
  return candidates.filter((c) => busy.get(c.runnerId) === false).slice(0, count);
}

export function networkName(prefix: string, pool: string): string {
  return `gha-${prefix}-${pool}`;
}

export function cacheVolumeName(prefix: string, pool: string, cache: string): string {
  return `gha-${prefix}-${pool}-${cache}`;
}

/** Labels GitHub matches `runs-on` against: the system ones, then the pool's own. */
export function runnerLabels(pool: Pool, arch: string): string[] {
  const archLabel = { x86_64: 'X64', amd64: 'X64', aarch64: 'ARM64', arm64: 'ARM64' }[arch] ?? arch.toUpperCase();
  return [...new Set(['self-hosted', 'Linux', archLabel, ...pool.labels])];
}

/** Docker Engine `POST /containers/create` body for one runner. */
export function containerSpec(input: {
  prefix: string;
  pool: Pool;
  name: string;
  runnerId: number;
  jitConfig: string;
}): Record<string, unknown> {
  const { prefix, pool, name, runnerId, jitConfig } = input;
  const cacheDirs = Object.values(pool.caches);
  return {
    Image: pool.image,
    Hostname: name.slice(0, 63),
    Env: [
      ...Object.entries(pool.env).map(([key, value]) => `${key}=${value}`),
      ...(cacheDirs.length > 0 ? [`RUNNER_CACHE_DIRS=${cacheDirs.join(':')}`] : []),
      `ACTIONS_RUNNER_INPUT_JITCONFIG=${jitConfig}`,
    ],
    Labels: {
      [LABEL.manager]: prefix,
      [LABEL.pool]: pool.name,
      [LABEL.org]: pool.org,
      [LABEL.runnerId]: String(runnerId),
    },
    HostConfig: {
      NetworkMode: networkName(prefix, pool.name),
      // tini as PID 1: orphans a job leaves behind are reaped, and all die with the container.
      Init: true,
      NanoCpus: Math.round(pool.cpus * 1e9),
      Memory: pool.memory,
      MemorySwap: pool.memory,
      PidsLimit: pool.pids,
      ShmSize: pool.shm,
      Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
      // Not needed by a CI job, and the raw-socket one allows ARP/ICMP spoofing on the bridge.
      CapDrop: pool.sudo ? ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'SETFCAP'] : ['ALL'],
      // Without sudo, nothing in the container may ever gain a privilege (setuid binaries included).
      SecurityOpt: pool.sudo ? [] : ['no-new-privileges:true'],
      ...(pool.runtime ? { Runtime: pool.runtime } : {}),
      ...(pool.disk ? { StorageOpt: { size: pool.disk } } : {}),
      Mounts: Object.entries(pool.caches).map(([cache, target]) => ({
        Type: 'volume',
        Source: cacheVolumeName(prefix, pool.name, cache),
        Target: target,
        VolumeOptions: { Labels: { [LABEL.manager]: prefix, [LABEL.pool]: pool.name } },
      })),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      RestartPolicy: { Name: 'no' },
    },
  };
}
