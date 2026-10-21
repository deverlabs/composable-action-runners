/**
 * Minimal Docker Engine API client over the unix socket: no docker CLI in the manager image.
 */

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

export interface ContainerState {
  ExitCode: number;
  StartedAt: string;
  FinishedAt: string;
  OOMKilled: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://docker${path}`, {
    method,
    unix: SOCKET,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {}
    throw new DockerError(res.status, `${method} ${path.split('?')[0]}: ${res.status} ${message}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await res.json() : await res.text()) as T;
}

/** Splits the multiplexed stdout/stderr stream of a container without a TTY. */
function demux(buffer: Uint8Array): string {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = view.getUint32(offset + 4);
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const docker = {
  info: () => call<{ NCPU: number; MemTotal: number; Architecture: string; Runtimes: Record<string, unknown> }>('GET', '/info'),

  listContainers(label: string): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return call('GET', `/containers/json?all=true&filters=${filters}`);
  },

  async inspectState(id: string): Promise<ContainerState> {
    return (await call<{ State: ContainerState }>('GET', `/containers/${id}/json`)).State;
  },

  async imageExists(ref: string): Promise<boolean> {
    try {
      await call('GET', `/images/${encodeURIComponent(ref)}/json`);
      return true;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return false;
      throw error;
    }
  },

  async ensureNetwork(name: string, labels: Record<string, string>): Promise<void> {
    try {
      await call('GET', `/networks/${encodeURIComponent(name)}`);
      return;
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
    await call('POST', '/networks/create', {
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: labels,
      // No traffic between the runners of a pool: concurrent jobs cannot reach each other.
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    });
  },

  async create(name: string, spec: unknown): Promise<string> {
    return (await call<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec)).Id;
  },

  start: (id: string) => call('POST', `/containers/${id}/start`),

  async stop(id: string, seconds: number): Promise<void> {
    try {
      await call('POST', `/containers/${id}/stop?t=${seconds}`);
    } catch (error) {
      // 304: already stopped, 404: already gone.
      if (!(error instanceof DockerError && (error.status === 304 || error.status === 404))) throw error;
    }
  },

  async remove(id: string): Promise<void> {
    try {
      await call('DELETE', `/containers/${id}?force=true&v=true`);
    } catch (error) {
      // 409: removal already in progress.
      if (!(error instanceof DockerError && (error.status === 404 || error.status === 409))) throw error;
    }
  },

  async logTail(id: string, lines: number): Promise<string> {
    const res = await fetch(`http://docker/containers/${id}/logs?stdout=true&stderr=true&tail=${lines}`, {
      unix: SOCKET,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    return demux(new Uint8Array(await res.arrayBuffer())).trimEnd();
  },
};
