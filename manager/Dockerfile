# Manager: TypeScript run by Bun, no dependency (Docker over its socket, GitHub over fetch,
# YAML through Bun.YAML). Pinned: a floating tag would make two builds of the same commit differ.
FROM oven/bun:1.4.3-alpine
WORKDIR /app
COPY src ./src
# Root without capabilities (compose drops them all): the docker socket is root-owned 660.
USER root
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD find /tmp/heartbeat -mmin -2 | grep -q .
ENTRYPOINT ["bun", "run", "src/main.ts"]
