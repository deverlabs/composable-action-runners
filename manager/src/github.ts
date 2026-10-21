/**
 * GitHub REST client for the org runner endpoints, with per-org credentials.
 *
 * Credentials, first match wins for an org:
 *   GITHUB_TOKEN_<ORG>   a PAT for that org only (org upper-cased, non-alphanumerics as `_`):
 *                        fine-grained with the org permission "Self-hosted runners: read and
 *                        write", or classic with `admin:org`.
 *   GITHUB_APP_ID +      a GitHub App installed on the org, with the org permission
 *   GITHUB_APP_PRIVATE_KEY_FILE   "Self-hosted runners: read and write".
 *   GITHUB_TOKEN         one PAT for every org (classic `admin:org`).
 *
 * These credentials never leave the manager: a runner container only receives its own JIT config.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
const TOKEN_MARGIN_MS = 5 * 60_000;
const GROUP_TTL_MS = 10 * 60_000;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Runner {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
}

interface AppCredentials {
  id: string;
  key: string;
}

function orgTokenVariable(org: string): string {
  return `GITHUB_TOKEN_${org.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function loadApp(): AppCredentials | undefined {
  const id = process.env.GITHUB_APP_ID;
  if (!id) return undefined;
  const file = process.env.GITHUB_APP_PRIVATE_KEY_FILE ?? '/run/secrets/github-app.pem';
  try {
    return { id, key: readFileSync(file, 'utf8') };
  } catch (error) {
    throw new Error(`GITHUB_APP_ID is set but its private key is unreadable at ${file}: ${(error as Error).message}`);
  }
}

function appJwt(app: AppCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  // iat is backdated for clock drift; GitHub caps exp at 10 minutes.
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(app.key, 'base64url')}`;
}

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
      await Bun.sleep(attempt * 1_000);
      continue;
    }
    if (res.status >= 500) {
      lastError = new GitHubError(res.status, `${method} ${path}: ${res.status} ${await res.text()}`);
      await Bun.sleep(attempt * 1_000);
      continue;
    }
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  throw lastError;
}

export class GitHub {
  private readonly app = loadApp();
  private readonly installationTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly groups = new Map<string, { id: number; at: number }>();

  /** Fails fast at startup when an org has no credential at all. */
  assertCredentials(org: string): void {
    if (process.env[orgTokenVariable(org)] || this.app || process.env.GITHUB_TOKEN) return;
    throw new Error(`no GitHub credential for org "${org}": set ${orgTokenVariable(org)}, GITHUB_APP_ID or GITHUB_TOKEN`);
  }

  private async token(org: string): Promise<string> {
    const own = process.env[orgTokenVariable(org)];
    if (own) return own;
    if (this.app) {
      const cached = this.installationTokens.get(org);
      if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;
      const jwt = appJwt(this.app);
      const installation = await call<{ id: number }>('GET', `/orgs/${org}/installation`, jwt);
      const minted = await call<{ token: string; expires_at: string }>(
        'POST',
        `/app/installations/${installation.id}/access_tokens`,
        jwt,
      );
      this.installationTokens.set(org, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });
      return minted.token;
    }
    const shared = process.env.GITHUB_TOKEN;
    if (shared) return shared;
    throw new Error(`no GitHub credential for org "${org}"`);
  }

  private async request<T>(org: string, method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await call<T>(method, path, await this.token(org), body);
    } catch (error) {
      // A revoked or expired installation token is minted again on the next call.
      if (error instanceof GitHubError && error.status === 401) this.installationTokens.delete(org);
      throw error;
    }
  }

  async runnerGroupId(org: string, name: string): Promise<number> {
    // Every org has the Default group, id 1, and the groups endpoint needs a paid plan.
    if (name.toLowerCase() === 'default') return 1;
    const key = `${org}\0${name.toLowerCase()}`;
    const cached = this.groups.get(key);
    if (cached && Date.now() - cached.at < GROUP_TTL_MS) return cached.id;
    const { runner_groups } = await this.request<{ runner_groups: { id: number; name: string }[] }>(
      org,
      'GET',
      `/orgs/${org}/actions/runner-groups?per_page=100`,
    );
    const group = runner_groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (!group) throw new Error(`runner group "${name}" not found in org "${org}"`);
    this.groups.set(key, { id: group.id, at: Date.now() });
    return group.id;
  }

  /**
   * Registers a just-in-time runner: ephemeral by construction (one job, then GitHub removes it),
   * configured without any registration token reaching the runner.
   */
  async createJitRunner(
    org: string,
    name: string,
    groupId: number,
    labels: string[],
  ): Promise<{ runnerId: number; jitConfig: string }> {
    const res = await this.request<{ runner: { id: number }; encoded_jit_config: string }>(
      org,
      'POST',
      `/orgs/${org}/actions/runners/generate-jitconfig`,
      { name, runner_group_id: groupId, labels, work_folder: '_work' },
    );
    return { runnerId: res.runner.id, jitConfig: res.encoded_jit_config };
  }

  async listRunners(org: string): Promise<Runner[]> {
    const runners: Runner[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request<{ total_count: number; runners: Runner[] }>(
        org,
        'GET',
        `/orgs/${org}/actions/runners?per_page=100&page=${page}`,
      );
      runners.push(...res.runners);
      if (res.runners.length < 100) return runners;
    }
  }

  /**
   * Removes a runner registration. `gone` when it no longer exists (an ephemeral runner removes
   * itself after its job), `busy` when GitHub refuses because a job is running on it.
   */
  async deleteRunner(org: string, runnerId: number): Promise<'deleted' | 'gone' | 'busy'> {
    try {
      await this.request(org, 'DELETE', `/orgs/${org}/actions/runners/${runnerId}`);
      return 'deleted';
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return 'gone';
      if (error instanceof GitHubError && error.status === 422) return 'busy';
      throw error;
    }
  }
}
