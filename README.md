# composable-action-runners

**Self-hosted GitHub Actions runners in Docker: a fresh container for every job, as many runners as
you want across as many organizations as you want, on one Linux host, with one
`docker compose up`.**

The ephemeral, just-in-time model of GitHub's Kubernetes controller (ARC), without Kubernetes.

- **One job, one container.** Each runner takes exactly one job, then its container is destroyed and
  replaced. No leftover `node_modules`, tokens in `$HOME`, zombie processes or half-installed
  packages from the previous job.
- **Credentials never reach a job.** A small manager holds the GitHub credentials and registers
  each runner just-in-time; the runner container only receives its own single-use config.
- **Many orgs, one config file.** Pools of runners per organization, each with its own count,
  labels, CPU, memory and process limits, edited live without restarting anything.
- **Safe by default.** No Docker socket in jobs, no privileged containers, no traffic between
  runners, and scaling down never interrupts a running job.

---

## Contents

- [Why this project](#why-this-project)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Sizing and performance](#sizing-and-performance)
- [Operations](#operations)
- [FAQ](#faq)
- [Limitations](#limitations)
- [Development](#development)

## Why this project

Running `actions-runner` directly on a machine works until two runners share it: they share `$HOME`,
the tool cache, `/tmp`, global git config, ports and every process a job leaves behind. Jobs start
interfering with each other, and a job can read what the previous one left on disk.

Putting the runner in a long-lived container moves the problem without solving it: the container is
restarted between jobs, not recreated, so its filesystem carries over, and the registration token
usually sits in the container's environment, readable by every job.

[Actions Runner Controller](https://github.com/actions/actions-runner-controller) solves both, but
needs a Kubernetes cluster.

| | Runner on the host | Long-lived runner container | ARC on Kubernetes | **composable-action-runners** |
|---|:-:|:-:|:-:|:-:|
| Clean environment for every job | ✗ | ✗ | ✓ | ✓ |
| GitHub credentials out of the job's reach | ✗ | usually ✗ | ✓ | ✓ |
| Concurrent jobs isolated from each other | ✗ | ✓ | ✓ | ✓ |
| CPU / memory / process limits per runner | ✗ | ✓ | ✓ | ✓ |
| Several organizations from one host | manual | manual | ✓ | ✓ |
| Scale down without killing running jobs | n/a | ✗ | ✓ | ✓ |
| Autoscaling on job demand | ✗ | ✗ | ✓ | ✗ (fixed warm pool) |
| Infrastructure needed | a machine | Docker | Kubernetes | **Docker** |

**When to use something else:** if you already operate Kubernetes, ARC gives you the same model plus
demand-based autoscaling. If you need macOS or Windows runners, this project is Linux only.

## How it works

```
docker compose
├── runner-image   builds the runner image, then exits
└── manager        keeps every pool at its count; the only holder of the Docker socket and GitHub credentials
        │  per runner: POST generate-jitconfig (GitHub) → docker create + start
        ▼
    <prefix>-<pool>-a1b2c3     1 container = 1 just-in-time runner = 1 job, then removed and replaced
```

**Just-in-time registration.** For each runner, the manager calls GitHub's
`generate-jitconfig` endpoint and hands the resulting config to the container. A JIT runner is
ephemeral by construction: it accepts a single job, then GitHub deregisters it. The runner reads its
config from the environment and clears it before running the job, so job steps never see it.

**Reconcile loop** (every 10 s):

1. **Reap**: stopped containers are removed and their registration deleted. A runner that died
   without running a job is logged with the tail of its output.
2. **Spawn**: every pool below its `count` gets new runners, each registered then started.
3. **Scale down**: idle runners beyond a pool's `count` are stopped. The registration is deleted
   first, which GitHub refuses for a busy runner, so a running job is never cut.
4. **Garbage-collect** (every 10 min): offline registrations carrying this host's prefix that no
   container backs (host crash, `docker rm -f`) are deleted.

**Live config.** `config/runners.yml` is re-read every tick. An invalid edit is logged and the last
valid config stays in force.

**Backoff.** A pool whose runners die at startup, whose registration fails or whose image is missing
pauses 15 s, then 30 s, doubling up to 5 min, instead of hammering the GitHub API.

**Graceful stop.** On `docker compose down`, idle runners stop at once and busy ones get
`DRAIN_SECONDS` (300 s) to finish their job.

## Quick start

Requirements: a Linux host with Docker Engine 24+ and the compose plugin. x64 and arm64 are both
detected automatically.

**1. Clone and create the two local files** (both git-ignored):

```bash
git clone https://github.com/deverlabs/composable-action-runners.git
cd composable-action-runners
cp .env.example .env
cp config/runners.example.yml config/runners.yml
```

**2. Create a GitHub credential** for each organization. The simplest is a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- **Resource owner**: the organization, not your personal account.
- **Repository access**: *Public repositories*, the minimum. No repository permission is needed.
- **Organization permissions** → **Self-hosted runners**: *Read and write*. Nothing else.

If the organization does not appear as a resource owner, an org owner must allow fine-grained
tokens: *Organization settings → Third-party Access → Personal access tokens*. Other options
(GitHub App, one classic token for all orgs) are described [below](#credentials).

**3. Fill in `.env`**:

```dotenv
RUNNER_NAME_PREFIX=ci1                        # [a-z0-9], no dash, unique per host
GITHUB_TOKEN_MY_ORG=github_pat_...            # one line per org: upper-cased, dashes as _
GITHUB_TOKEN_OTHER_ORG=github_pat_...
```

```bash
chmod 600 .env
```

**4. Describe your pools** in `config/runners.yml`:

```yaml
defaults:
  cpus: 4
  memory: 8g
  labels: [docker-runner]

pools:
  - name: my-org
    org: my-org
    count: 3

  - name: other-org
    org: other-org
    count: 2
```

**5. Start**:

```bash
docker compose up -d --build
docker compose logs -f manager
```

You should see `config loaded`, then one `started for <org>` line per runner. The runners appear as
*Idle* under *Organization settings → Actions → Runners*. Point a workflow at them:

```yaml
jobs:
  test:
    runs-on: [self-hosted, docker-runner]
```

**6. Harden the host network** (see [Security model](#security-model)) and retire any runner
previously installed on the machine.

## Configuration

### Pools: `config/runners.yml`

A pool is `count` identical runners for one organization. An organization can have several pools,
for example a default one and a bigger one behind a `heavy` label. Every key except `name`, `org`
and `count` can also be set once under `defaults`.

| Key | Default | Meaning |
|---|---|---|
| `name` | required | `[a-z0-9-]`, unique. Names the containers, network and cache volumes. |
| `org` | required | GitHub organization the runners register in. |
| `count` | required | Runners kept alive, idle or busy. `0` drains the pool. |
| `labels` | `[]` | Extra labels. Every runner also carries `self-hosted`, `Linux` and `X64` or `ARM64`. |
| `group` | `Default` | Runner group. The default group does not serve public repositories unless the org allows it. |
| `cpus` | `2` | CPU limit, fractions allowed. A ceiling, not a reservation: see [sizing](#sizing-and-performance). |
| `memory` | `4g` | Memory limit; swap is disabled. |
| `pids` | `4096` | Process limit, against fork bombs and leaked child processes. |
| `shm` | `1g` | Size of `/dev/shm`. Docker's 64 MB default crashes Chromium-based browsers. |
| `disk` | none | Writable-layer quota, e.g. `30g`. Requires overlay2 on xfs mounted with `pquota`. |
| `runtime` | Docker's | OCI runtime registered in the daemon: `runsc` (gVisor) or `sysbox-runc`. |
| `sudo` | `true` | Passwordless sudo in jobs. `false` also sets `no-new-privileges` and drops all capabilities. |
| `caches` | `{}` | `name: /absolute/path`. A volume shared by the pool's runners, kept across jobs. |
| `env` | `{}` | Extra environment variables, non-secret. Secrets belong in GitHub secrets. |
| `image` | `gha-runner:local` | Runner image. |

**Caches** trade isolation for speed. Without one, every job downloads its dependencies again;
with one, the package manager finds them on disk:

```yaml
defaults:
  caches:
    bun: /home/runner/.bun/install/cache    # or ~/.npm, ~/.cache/pip, ...
    turbo: /home/runner/.cache/turbo
  env:
    TURBO_CACHE_DIR: /home/runner/.cache/turbo
```

Package caches store each version side by side, so repositories pinning different versions do not
conflict. But a cache is the one thing a job can leave for the next one: use caches only on pools
whose repositories you trust equally. Each pool gets its own volume, never shared across pools or
organizations.

### Credentials

The manager picks, for each organization, the first credential found:

| Variable | Credential | Scope |
|---|---|---|
| `GITHUB_TOKEN_<ORG>` | Fine-grained token, resource owner = that org, *Self-hosted runners: Read and write* | One org, one permission. **Recommended.** |
| `GITHUB_APP_ID` + `secrets/github-app.pem` | GitHub App with the org permission *Self-hosted runners: Read and write*, installed on each org | Every org it is installed on. An App installable on several orgs must be public ("Any account"), which only lets an org install it. |
| `GITHUB_TOKEN` | Classic token with `admin:org` | Every org you administer, with full admin rights. Avoid. |

`<ORG>` is the organization name upper-cased, every non-alphanumeric character replaced by `_`:
`my-org` → `GITHUB_TOKEN_MY_ORG`. A pool whose org has no credential is rejected at load time, with
the variable name to set in the log.

### Manager settings: `.env`

| Variable | Default | Meaning |
|---|---|---|
| `RUNNER_NAME_PREFIX` | required | Prefix of every runner name. `[a-z0-9]`, no dash, **unique per host**: garbage collection only deletes registrations carrying it. |
| `RUNNER_VERSION` | `latest` | Tag of `ghcr.io/actions/actions-runner` the image builds from. |
| `TICK_SECONDS` | `10` | Reconcile period. |
| `GC_MINUTES` | `10` | Orphan registration sweep period. |
| `DRAIN_SECONDS` | `300` | Time busy runners get to finish on stop. Keep below compose's `stop_grace_period` (330 s). |
| `GITHUB_API_URL` | `https://api.github.com` | API base URL, e.g. for GitHub Enterprise Server (untested). |

### The runner image

Built from the official `ghcr.io/actions/actions-runner` (Ubuntu 24.04), plus:

- **Node.js 26** and npm on `PATH`, as on `ubuntu-latest`. Without a real `node`, `bun run` executes
  `#!/usr/bin/env node` tools under Bun, and Node-only APIs break in confusing ways.
- `git`, `curl`, `jq`, `unzip`, `zip`, `xz`, `zstd`, `rsync`, `wget`, `openssh-client`;
- `build-essential`, `pkg-config`, `python3` with `venv`;
- the `en_US.UTF-8` locale, and the Docker CLI without a daemon.

Anything else (other Node versions, Bun, Go, Java, browsers) installs per job with the usual
`setup-*` actions, or goes into `runner/Dockerfile` if every job needs it.

## Security model

| Between | Isolation |
|---|---|
| Two consecutive jobs | The container is destroyed: `$HOME`, `/tmp`, the workspace, installed packages and leftover processes are gone. Only explicit `caches` survive. |
| Two concurrent jobs | Separate containers on a per-pool network with inter-container traffic disabled. |
| A job and the host | No Docker socket, never privileged, `tini` as PID 1, `NET_RAW`, `MKNOD`, `SYS_CHROOT` and `SETFCAP` dropped. With `sudo: false`, `no-new-privileges` and no capabilities at all. |
| A job and the credentials | Tokens and App keys stay in the manager. A runner only knows its own single-use JIT config, cleared before the job starts. |
| Two organizations | Separate pools, registrations and networks. |

**Harden on the host.** These are not covered by default:

- **Outbound network.** Jobs reach the internet, but also the host's LAN and, on a cloud VM, the
  metadata service at `169.254.169.254`, which can hand out the VM's credentials. Block them in the
  `DOCKER-USER` chain and make the rules persistent:

  ```bash
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 169.254.169.254 -j DROP
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 10.0.0.0/8 -j DROP
  sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 192.168.0.0/16 -j DROP
  ```

  Adapt the source range to your runner networks:
  `docker network inspect $(docker network ls -q --filter label=gha.manager)`.

- **Disk.** Without `disk`, a job can fill the partition holding `/var/lib/docker`. Give it its own
  partition.
- **Kernel.** Containers share the host kernel. For untrusted code, such as pull requests from forks
  of a public repository, use `runtime: runsc` (gVisor), or keep public repositories out of the
  runner group.

## Sizing and performance

**Be generous with `cpus`.** It is a ceiling, not a reservation: idle runners use almost nothing, and
busy runners share the cores like any processes would. A tight limit starves parallel tools (test
runners, `turbo`, bundlers): a test suite that took 19 s with the whole machine took 114 s capped at
2 CPUs. Start at 4 CPUs and 8 GB per runner, raise `cpus` toward the number of cores minus 2 for
heavy parallel suites, and keep `count × memory` below the host's RAM.

The manager warns when the pools could reserve more CPU or memory than the host has. It is only a
warning: it matters when every runner is busy at once, and an out-of-memory kill is logged as
`OOM-killed (raise the pool memory)`.

**Expect cold caches.** A fresh container has no `node_modules`, no build cache and no tool cache.
Jobs that relied on a warm machine will be slower until you add `caches` for the package manager and
the build tool.

**Network and disk.** Downloads much slower in jobs than on the host usually mean an MTU mismatch
(VPN, PPPoE) or a Wi-Fi uplink. Disk-heavy jobs benefit from `/var/lib/docker` on local NVMe mounted
with `noatime`.

## Operations

| Task | Command |
|---|---|
| List runners | `docker ps --filter label=gha.manager=<prefix> --format 'table {{.Names}}\t{{.Label "gha.org"}}\t{{.Status}}'` |
| Manager logs | `docker compose logs -f manager` |
| Live logs of a runner | `docker logs -f <name>` (job logs stay on GitHub) |
| Change counts or limits | Edit `config/runners.yml`: applied within 10 s. Running runners keep their limits until their job ends. |
| Apply new limits now | `docker compose restart manager`: idle runners are replaced at once, busy ones after their job (up to `DRAIN_SECONDS`) |
| Update the runner | `docker compose build --pull runner-image`. New containers use the new image; running ones finish on the old one. |
| Update the manager | `git pull && docker compose up -d --build manager` |
| Stop everything | `docker compose down` |

**Keep the image fresh.** GitHub stops sending jobs to deprecated runner versions, and a stale image
makes every fresh container download a runner update before its first job. A weekly rebuild also
picks up Ubuntu security fixes and the latest Node.js 26:

```bash
(crontab -l 2>/dev/null; echo '0 4 * * 1 cd /srv/composable-action-runners && docker compose build --pull runner-image >/dev/null 2>&1 && docker image prune -f >/dev/null') | crontab -
```

## FAQ

**`docker compose ps` only shows the manager. Where are my runners?**
The manager creates runner containers through the Docker API, outside compose. List them with
`docker ps --filter label=gha.manager=<prefix>`.

**Are runners started when a job arrives?**
No, they wait in advance: each pool always has `count` runners connected and idle, so a job starts
instantly. When a job ends, its container is replaced within seconds. An idle runner uses a few tens
of MB of RAM and no CPU.

**A runner keeps dying with `exited 70 … without running a job`.**
The runner could not connect: rejected credential, runner version too old (rebuild the image), or
no network. The lines above it in the manager log say which. The pool backs off meanwhile.

**The manager logs `401` or `403`.**
`401`: the token is wrong or expired. `403`: it lacks the *Self-hosted runners* organization
permission, or targets the wrong resource owner.

**Can a job use Docker (`services:`, `container:`, `docker build`)?**
Not by default, on purpose: giving jobs the host's Docker socket gives them root on the host. The
safe route is [Sysbox](https://github.com/nestybox/sysbox) (`runtime: sysbox-runc`) with a Docker
daemon in the runner image, which is not shipped yet.

**Can one host serve several organizations?**
Yes, that is the point: one pool per organization, each with its own credential, in the same
`runners.yml`.

**Can two hosts serve the same organization?**
Yes, with a different `RUNNER_NAME_PREFIX` on each.

## Limitations

- **Fixed warm pool**: `count` runners are always up. There is no scaling on queue depth.
- **No Docker in jobs** yet (see the FAQ).
- **Linux hosts only**, x64 or arm64.
- **Organization runners only**: no repository-level or enterprise-level runners.

## Development

The manager is TypeScript run by Bun, with no runtime dependency: Docker through its socket, GitHub
through `fetch`, YAML through `Bun.YAML`.

```bash
cd manager && bun install && bun test && bun run typecheck
```

| File | Role |
|---|---|
| `manager/src/plan.ts` | Pure decisions: what to reap, spawn or scale down, and each runner's container spec. Where tests go. |
| `manager/src/main.ts` | The reconcile loop, drain and garbage collection: the I/O. |
| `manager/src/github.ts` | GitHub REST client and per-org credentials. |
| `manager/src/docker.ts` | Minimal Docker Engine API client. |
| `manager/src/config.ts` | `runners.yml` parsing and validation. |
| `runner/` | Runner image and its entrypoint. |
