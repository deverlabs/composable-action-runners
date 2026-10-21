import { describe, expect, test } from 'bun:test';
import { parseConfig, type Pool } from '../src/config';
import { containerSpec, type Managed, plan, runnerLabels } from '../src/plan';

function pools(yaml: string): Pool[] {
  return parseConfig(yaml, 'gha-runner:local').pools;
}

let seq = 0;
function managed(pool: string, org: string, state = 'running'): Managed {
  seq++;
  return { id: `c${seq}`, name: `ci1-${pool}-${seq}`, state, pool, org, runnerId: seq };
}

describe('plan', () => {
  test('spawns the missing runners of each pool', () => {
    const config = pools('pools: [{ name: a, org: acme, count: 3 }, { name: b, org: beta, count: 1 }]');
    const result = plan(config, [managed('a', 'acme')]);
    expect(result.spawn.map((s) => [s.pool.name, s.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(result.excess).toEqual([]);
  });

  test('reaps every stopped container and does not count it as capacity', () => {
    const exited = managed('a', 'acme', 'exited');
    const created = managed('a', 'acme', 'created');
    const removing = managed('a', 'acme', 'removing');
    const result = plan(pools('pools: [{ name: a, org: acme, count: 1 }]'), [exited, created, removing]);
    expect(result.reap).toEqual([exited, created]);
    expect(result.spawn.map((s) => s.count)).toEqual([1]);
  });

  test('a lowered count makes the surplus excess, with the whole pool as candidates', () => {
    const running = [managed('a', 'acme'), managed('a', 'acme'), managed('a', 'acme')];
    const result = plan(pools('pools: [{ name: a, org: acme, count: 1 }]'), running);
    expect(result.excess).toEqual([{ org: 'acme', count: 2, candidates: running }]);
    expect(result.spawn).toEqual([]);
  });

  test('a removed pool is wholly excess, grouped by the org its runners belong to', () => {
    const gone = [managed('old', 'acme'), managed('old', 'acme'), managed('other', 'beta')];
    const result = plan([], gone);
    expect(result.excess).toEqual([
      { org: 'acme', count: 2, candidates: gone.slice(0, 2) },
      { org: 'beta', count: 1, candidates: gone.slice(2) },
    ]);
  });

  test('a pool moved to another org replaces its runners instead of counting them', () => {
    const old = managed('a', 'acme');
    const result = plan(pools('pools: [{ name: a, org: beta, count: 1 }]'), [old]);
    expect(result.spawn.map((s) => [s.pool.org, s.count])).toEqual([['beta', 1]]);
    expect(result.excess).toEqual([{ org: 'acme', count: 1, candidates: [old] }]);
  });
});

describe('runnerLabels', () => {
  test('system labels first, architecture normalized, duplicates dropped', () => {
    const [pool] = pools('pools: [{ name: a, org: acme, count: 1, labels: [heavy, self-hosted] }]');
    expect(runnerLabels(pool, 'x86_64')).toEqual(['self-hosted', 'Linux', 'X64', 'heavy']);
    expect(runnerLabels(pool, 'aarch64')).toEqual(['self-hosted', 'Linux', 'ARM64', 'heavy']);
  });
});

describe('containerSpec', () => {
  const [sudo, locked] = pools(`
pools:
  - { name: a, org: acme, count: 1, cpus: 1.5, memory: 2g, pids: 500, env: { FOO: bar }, caches: { bun: /home/runner/.bun/install/cache } }
  - { name: b, org: acme, count: 1, sudo: false, runtime: sysbox-runc, disk: 20G }
`);

  test('limits, isolation and identity labels of a sudo pool', () => {
    const spec = containerSpec({ prefix: 'ci1', pool: sudo, name: 'ci1-a-abc', runnerId: 42, jitConfig: 'JIT' }) as {
      Env: string[];
      Labels: Record<string, string>;
      HostConfig: Record<string, unknown>;
    };
    expect(spec.Env).toEqual([
      'FOO=bar',
      'RUNNER_CACHE_DIRS=/home/runner/.bun/install/cache',
      'ACTIONS_RUNNER_INPUT_JITCONFIG=JIT',
    ]);
    expect(spec.Labels).toEqual({ 'gha.manager': 'ci1', 'gha.pool': 'a', 'gha.org': 'acme', 'gha.runner-id': '42' });
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'gha-ci1-a',
      Init: true,
      NanoCpus: 1_500_000_000,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      PidsLimit: 500,
      CapDrop: ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'SETFCAP'],
      SecurityOpt: [],
      RestartPolicy: { Name: 'no' },
      Mounts: [
        {
          Type: 'volume',
          Source: 'gha-ci1-a-bun',
          Target: '/home/runner/.bun/install/cache',
          VolumeOptions: { Labels: { 'gha.manager': 'ci1', 'gha.pool': 'a' } },
        },
      ],
    });
    expect(spec.HostConfig).not.toHaveProperty('Privileged');
    expect(spec.HostConfig).not.toHaveProperty('Binds');
    expect(spec.HostConfig).not.toHaveProperty('Runtime');
  });

  test('a pool without sudo gets no capability and no-new-privileges', () => {
    const spec = containerSpec({ prefix: 'ci1', pool: locked, name: 'ci1-b-abc', runnerId: 1, jitConfig: 'JIT' }) as {
      Env: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(spec.Env).toEqual(['ACTIONS_RUNNER_INPUT_JITCONFIG=JIT']);
    expect(spec.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Runtime: 'sysbox-runc',
      StorageOpt: { size: '20G' },
      Mounts: [],
    });
  });
});
