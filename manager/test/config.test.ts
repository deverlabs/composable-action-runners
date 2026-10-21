import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ConfigError, parseConfig, parseSize } from '../src/config';

const IMAGE = 'gha-runner:local';

function problems(yaml: string): string[] {
  try {
    parseConfig(yaml, IMAGE);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('parseSize', () => {
  test('reads binary units, case-insensitive, optional b', () => {
    expect(parseSize('4g')).toBe(4 * 1024 ** 3);
    expect(parseSize('512M')).toBe(512 * 1024 ** 2);
    expect(parseSize('1.5gb')).toBe(1.5 * 1024 ** 3);
    expect(parseSize(1024)).toBe(1024);
  });

  test('rejects garbage, zero and non-scalars', () => {
    expect(parseSize('4 gigs')).toBeUndefined();
    expect(parseSize('0g')).toBeUndefined();
    expect(parseSize(['4g'])).toBeUndefined();
    expect(parseSize(undefined)).toBeUndefined();
  });
});

describe('parseConfig', () => {
  test('merges builtin defaults, then `defaults`, then the pool', () => {
    const { pools } = parseConfig(
      `
defaults: { cpus: 3, labels: [shared] }
pools:
  - { name: a, org: acme, count: 2 }
  - { name: b, org: acme, count: 1, cpus: 0.5, memory: 1g, labels: [heavy, heavy], sudo: false }
`,
      IMAGE,
    );
    expect(pools).toEqual([
      {
        name: 'a',
        org: 'acme',
        count: 2,
        labels: ['shared'],
        group: 'Default',
        image: IMAGE,
        cpus: 3,
        memory: 8 * 1024 ** 3,
        pids: 4096,
        shm: 1024 ** 3,
        disk: undefined,
        runtime: undefined,
        sudo: true,
        caches: {},
        env: {},
      },
      {
        name: 'b',
        org: 'acme',
        count: 1,
        labels: ['heavy'],
        group: 'Default',
        image: IMAGE,
        cpus: 0.5,
        memory: 1024 ** 3,
        pids: 4096,
        shm: 1024 ** 3,
        disk: undefined,
        runtime: undefined,
        sudo: false,
        caches: {},
        env: {},
      },
    ]);
  });

  test('without any defaults, a runner gets 4 CPUs and 8 GB, as documented', () => {
    const [pool] = parseConfig('pools: [{ name: a, org: acme, count: 1 }]', IMAGE).pools;
    expect([pool.cpus, pool.memory]).toEqual([4, 8 * 1024 ** 3]);
  });

  test('a top-level image applies to every pool that does not set its own', () => {
    const { pools } = parseConfig(
      `
image: custom:1
pools:
  - { name: a, org: acme, count: 1 }
  - { name: b, org: acme, count: 1, image: other:2 }
`,
      IMAGE,
    );
    expect(pools.map((p) => p.image)).toEqual(['custom:1', 'other:2']);
  });

  test('count 0 is valid: the pool is kept but drained', () => {
    expect(parseConfig('pools: [{ name: a, org: acme, count: 0 }]', IMAGE).pools[0].count).toBe(0);
  });

  test('reports every problem of the file at once', () => {
    expect(
      problems(`
pools:
  - { name: Bad_Name, org: acme, count: -1, memory: 100m, typo: 1 }
  - { name: ok, count: 1.5, labels: ["a,b"], disk: lots, caches: { bun: relative/path } }
`).sort(),
    ).toEqual(
      [
        'pools[0].count: integer >= 0 required',
        'pools[0].memory: expected a size >= 256m',
        'pools[0].name: required, [a-z0-9-], 30 chars max',
        'pools[0].typo: unknown key',
        'pools[1].caches.bun: path must be absolute',
        'pools[1].count: integer >= 0 required',
        'pools[1].disk: expected a size',
        'pools[1].labels: expected a list of non-empty strings without commas',
        'pools[1].org: required',
      ].sort(),
    );
  });

  test('rejects duplicate pool names', () => {
    expect(problems('pools: [{ name: a, org: x, count: 1 }, { name: a, org: y, count: 1 }]')).toEqual([
      'pools[1].name: duplicate pool "a"',
    ]);
  });

  test('rejects pool env that would shadow the runner inputs', () => {
    expect(problems('pools: [{ name: a, org: x, count: 1, env: { ACTIONS_RUNNER_INPUT_JITCONFIG: x } }]')).toEqual([
      'pools[0].env.ACTIONS_RUNNER_INPUT_JITCONFIG: ACTIONS_RUNNER_* is reserved',
    ]);
  });

  test('per-pool identity keys are refused in defaults', () => {
    expect(problems('defaults: { count: 2 }\npools: []')).toEqual(['defaults.count: set per pool only']);
  });

  test('invalid YAML and a missing pools list are config errors', () => {
    expect(problems('pools: [')[0]).toStartWith('YAML: ');
    expect(problems('image: x')).toEqual(['pools: expected a list']);
  });

  test('the shipped runners.example.yml is valid', () => {
    const text = readFileSync(new URL('../../config/runners.example.yml', import.meta.url), 'utf8');
    expect(parseConfig(text, IMAGE).pools.length).toBeGreaterThan(0);
  });
});
