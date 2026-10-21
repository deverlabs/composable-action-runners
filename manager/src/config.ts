/**
 * Loads and validates `runners.yml`: the pools of runners the manager keeps alive.
 *
 * A pool is N identical runners for one organization. `defaults` is merged under every pool, so a
 * pool only states what differs. Every error is collected before throwing, so one reload reports
 * all of them.
 */

import { readFileSync } from 'node:fs';

export interface Pool {
  name: string;
  org: string;
  count: number;
  /** Custom labels, on top of `self-hosted`, `Linux` and the architecture the manager adds. */
  labels: string[];
  group: string;
  image: string;
  cpus: number;
  /** Bytes. Swap is disabled: memory + swap is pinned to this value. */
  memory: number;
  pids: number;
  /** Bytes of /dev/shm (Docker's 64 MB breaks Chromium-based tests). */
  shm: number;
  /** Writable layer quota, e.g. `20G`. Only honoured by overlay2 on xfs with pquota. */
  disk?: string;
  /** OCI runtime, e.g. `sysbox-runc` or `runsc`. Must be registered in the daemon. */
  runtime?: string;
  sudo: boolean;
  /** Cache name to absolute path in the runner. Shared by every runner of the pool, across jobs. */
  caches: Record<string, string>;
  env: Record<string, string>;
}

export interface Config {
  pools: Pool[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid runners config:\n  - ${problems.join('\n  - ')}`);
  }
}

const POOL_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
const CACHE_NAME = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i;
const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const POOL_KEYS = new Set([
  'name',
  'org',
  'count',
  'labels',
  'group',
  'image',
  'cpus',
  'memory',
  'pids',
  'shm',
  'disk',
  'runtime',
  'sudo',
  'caches',
  'env',
]);

const BUILTIN_DEFAULTS = {
  labels: [],
  group: 'Default',
  // Ceilings, not reservations: 2 CPUs starved parallel test suites.
  cpus: 4,
  memory: '8g',
  pids: 4096,
  shm: '1g',
  sudo: true,
  caches: {},
  env: {},
};

export function parseSize(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = SIZE.exec(String(value).trim());
  if (!match) return undefined;
  const bytes = Math.floor(Number(match[1]) * UNITS[match[2].toLowerCase()]);
  return bytes > 0 ? bytes : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown, where: string, problems: string[]): Record<string, string> {
  if (!isRecord(value)) {
    problems.push(`${where}: expected a map`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      problems.push(`${where}.${key}: expected a scalar`);
      continue;
    }
    out[key] = String(item);
  }
  return out;
}

function parsePool(raw: Record<string, unknown>, where: string, image: string, problems: string[]): Pool | undefined {
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (!POOL_KEYS.has(key)) problems.push(`${where}.${key}: unknown key`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || !POOL_NAME.test(name)) {
    problems.push(`${where}.name: required, [a-z0-9-], 30 chars max`);
  }
  const org = raw.org;
  if (typeof org !== 'string' || org === '') problems.push(`${where}.org: required`);

  const count = raw.count;
  if (!Number.isInteger(count) || (count as number) < 0) problems.push(`${where}.count: integer >= 0 required`);

  const labels = raw.labels;
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l === '' || l.includes(','))) {
    problems.push(`${where}.labels: expected a list of non-empty strings without commas`);
  }

  const group = raw.group;
  if (typeof group !== 'string' || group === '') problems.push(`${where}.group: expected a runner group name`);

  const cpus = raw.cpus;
  if (typeof cpus !== 'number' || !(cpus > 0)) problems.push(`${where}.cpus: expected a number > 0`);

  const memory = parseSize(raw.memory);
  if (memory === undefined || memory < 256 * 1024 ** 2) problems.push(`${where}.memory: expected a size >= 256m`);

  const shm = parseSize(raw.shm);
  if (shm === undefined) problems.push(`${where}.shm: expected a size`);

  const pids = raw.pids;
  if (!Number.isInteger(pids) || (pids as number) < 64) problems.push(`${where}.pids: integer >= 64 required`);

  const disk = raw.disk;
  if (disk !== undefined && parseSize(disk) === undefined) problems.push(`${where}.disk: expected a size`);

  const runtime = raw.runtime;
  if (runtime !== undefined && (typeof runtime !== 'string' || runtime === '')) {
    problems.push(`${where}.runtime: expected a runtime name`);
  }

  if (typeof raw.sudo !== 'boolean') problems.push(`${where}.sudo: expected true or false`);

  const poolImage = raw.image ?? image;
  if (typeof poolImage !== 'string' || poolImage === '') problems.push(`${where}.image: expected an image reference`);

  const caches = stringMap(raw.caches, `${where}.caches`, problems);
  for (const [cache, path] of Object.entries(caches)) {
    if (!CACHE_NAME.test(cache)) problems.push(`${where}.caches.${cache}: name must be [a-z0-9_-]`);
    if (!path.startsWith('/')) problems.push(`${where}.caches.${cache}: path must be absolute`);
  }

  const env = stringMap(raw.env, `${where}.env`, problems);
  for (const key of Object.keys(env)) {
    if (!ENV_NAME.test(key)) problems.push(`${where}.env.${key}: invalid variable name`);
    // The runner reads its own arguments from ACTIONS_RUNNER_INPUT_*: a pool must not shadow them.
    if (key.startsWith('ACTIONS_RUNNER_')) problems.push(`${where}.env.${key}: ACTIONS_RUNNER_* is reserved`);
  }

  if (problems.length > before) return undefined;
  return {
    name: name as string,
    org: org as string,
    count: count as number,
    labels: [...new Set(labels as string[])],
    group: group as string,
    image: poolImage as string,
    cpus: cpus as number,
    memory: memory as number,
    pids: pids as number,
    shm: shm as number,
    disk: disk === undefined ? undefined : String(disk),
    runtime: runtime as string | undefined,
    sudo: raw.sudo as boolean,
    caches,
    env,
  };
}

export function parseConfig(text: string, defaultImage: string): Config {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (error) {
    throw new ConfigError([`YAML: ${(error as Error).message}`]);
  }
  if (!isRecord(doc)) throw new ConfigError(['top level: expected a map with `pools`']);

  const problems: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!['image', 'defaults', 'pools'].includes(key)) problems.push(`${key}: unknown key`);
  }
  const image = doc.image ?? defaultImage;
  if (typeof image !== 'string' || image === '') problems.push('image: expected an image reference');

  const defaults = doc.defaults ?? {};
  if (!isRecord(defaults)) problems.push('defaults: expected a map');
  else {
    for (const key of ['name', 'org', 'count']) {
      if (key in defaults) problems.push(`defaults.${key}: set per pool only`);
    }
  }

  if (!Array.isArray(doc.pools)) {
    problems.push('pools: expected a list');
    throw new ConfigError(problems);
  }

  const pools: Pool[] = [];
  const names = new Set<string>();
  doc.pools.forEach((raw, index) => {
    const where = `pools[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: expected a map`);
      return;
    }
    const merged = { ...BUILTIN_DEFAULTS, ...(isRecord(defaults) ? defaults : {}), ...raw };
    const pool = parsePool(merged, where, image as string, problems);
    if (!pool) return;
    if (names.has(pool.name)) problems.push(`${where}.name: duplicate pool "${pool.name}"`);
    names.add(pool.name);
    pools.push(pool);
  });

  if (problems.length > 0) throw new ConfigError(problems);
  return { pools };
}

export function loadConfig(path: string, defaultImage: string): Config {
  return parseConfig(readFileSync(path, 'utf8'), defaultImage);
}
