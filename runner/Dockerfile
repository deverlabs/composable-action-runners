# Runner image: the official one (Ubuntu 24.04, runner in /home/runner, user `runner` uid 1001
# with passwordless sudo, git, curl, jq, unzip, docker CLI without a daemon), plus the build basics
# CI jobs expect from ubuntu-latest. Language toolchains are not baked in: setup-* actions install
# them per job, or a pool cache keeps them between jobs.
#
# Rebuild regularly (`docker compose build --pull runner-image`): GitHub stops sending jobs to a
# runner version it deprecated, and a stale image makes every fresh container self-update first.
ARG RUNNER_VERSION=latest
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        file \
        gnupg \
        locales \
        openssh-client \
        pkg-config \
        python3 \
        python3-venv \
        rsync \
        tzdata \
        wget \
        xz-utils \
        zip \
        zstd \
    && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# Usual cache locations, created and owned by `runner` in the image: a pool cache volume mounted
# there starts with this ownership, so it is writable even by a pool without sudo. `chown -R` on
# the top-level directories: `install -d -o` would only own the last level, leaving `_work` and
# `.bun` root-owned, where the runner creates `_temp` and setup-bun installs.
RUN mkdir -p \
        /home/runner/.cache \
        /home/runner/.bun/install/cache \
        /home/runner/.npm \
        /home/runner/_work/_tool \
    && chown -R runner:runner \
        /home/runner/.cache \
        /home/runner/.bun \
        /home/runner/.npm \
        /home/runner/_work

COPY --chmod=755 entrypoint.sh /usr/local/bin/runner-entrypoint

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
