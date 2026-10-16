# syntax=docker/dockerfile:1.7
# VKS Migration Studio engine + UI. Build from the repository root:
#   docker build -f deploy/Dockerfile -t vks-migration-studio .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- engine: compile TypeScript, keep production dependencies only
FROM ${NODE_IMAGE} AS engine
WORKDIR /src/engine
# Toolchain only used if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY engine/package.json engine/package-lock.json ./
RUN npm ci
COPY engine/tsconfig.json ./
COPY engine/src ./src
RUN npm run build && npm prune --omit=dev

# ---- ui: static build
FROM ${NODE_IMAGE} AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ---- runtime
FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.1
LABEL org.opencontainers.image.title="VKS Migration Studio" \
      org.opencontainers.image.description="Plan and pilot Kubernetes workload migrations to VMware vSphere Kubernetes Service" \
      org.opencontainers.image.source="https://github.com/avnish80/vks-migration-studio" \
      org.opencontainers.image.licenses="Apache-2.0"

# Python 3 runs the existing pilot runners; Skopeo verifies and copies images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 skopeo \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 studio && useradd --uid 10001 --gid studio --home-dir /home/studio --create-home --shell /usr/sbin/nologin studio \
 && mkdir -p /data && chown studio:studio /data

WORKDIR /app
COPY --from=engine /src/engine/build ./engine/build
COPY --from=engine /src/engine/node_modules ./engine/node_modules
COPY --from=engine /src/engine/package.json ./engine/package.json
COPY --from=ui /src/ui/dist ./ui/dist
# Reused planning modules and the Python runners.
COPY dist ./dist
COPY LICENSE README.md ./

ENV NODE_ENV=production \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=8080 \
    STUDIO_DATA_DIR=/data \
    STUDIO_UI_DIR=/app/ui/dist \
    STUDIO_CORE_DIR=/app/dist \
    KUBECONFIG=/home/studio/.kube/config

USER studio
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "engine/build/server.js"]
