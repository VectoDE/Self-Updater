# Container image of the self-updater agent: ghcr.io/vectode/self-updater
#
# The configuration lives in /config (updater.config.json, optional .env); the workspace it deploys is a mounted
# directory. For the docker and compose service types, mount /var/run/docker.sock and add the socket's group with
# --group-add. See "Run in a container" in the README.

# Base image pinned by digest; Dependabot proposes updates.
FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsdown.config.ts README.md LICENSE CHANGELOG.md ./
COPY src ./src
RUN npm run build && npm pack --ignore-scripts --pack-destination /tmp

# Docker Compose built from source with the current Go release: the published binaries and the Alpine package still
# carry a Go standard library with known vulnerabilities. Cross-compiled on the build platform, so arm64 builds fast.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS compose
ARG TARGETOS
ARG TARGETARCH
ARG COMPOSE_VERSION=v5.6.0
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
# go mod download checks the module against the Go checksum database. Compose's go.mod has exclude directives, which
# go install refuses, so it is built inside the downloaded module with its own go.sum.
RUN go mod download -json "github.com/docker/compose/v5@$COMPOSE_VERSION" > /tmp/module.json \
    && dir="$(sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p' /tmp/module.json)" \
    && test -n "$dir" \
    && cd "$dir" \
    && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -mod=readonly \
      -ldflags "-w -X github.com/docker/compose/v5/internal.Version=$COMPOSE_VERSION" \
      -o /out/docker-compose ./cmd

# The Docker CLI from the official image, which is rebuilt with each Go release.
FROM docker:29.9.0-cli-alpine3.24@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 AS docker-cli

FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
LABEL org.opencontainers.image.source="https://github.com/VectoDE/Self-Updater" \
      org.opencontainers.image.description="Keeps a server checkout in sync with its Git repository" \
      org.opencontainers.image.licenses="Apache-2.0"
# git and ssh for the repository, tini to forward signals so a running deployment can finish before the container
# stops. apk upgrade picks up security fixes released after the base image.
RUN apk upgrade --no-cache && apk add --no-cache git openssh-client tini
# The Docker CLI with the compose plugin for the docker and compose service types.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compose /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=build /tmp/vectode-self-updater-*.tgz /tmp/
# The package has no runtime dependencies, so nothing else is downloaded.
RUN npm install --global --ignore-scripts --no-audit --no-fund /tmp/vectode-self-updater-*.tgz \
    && rm /tmp/vectode-self-updater-*.tgz \
    && mkdir -p /config /srv/app \
    && chown node:node /config /srv/app
USER node
WORKDIR /config
ENV SELF_UPDATER_CONFIG=/config/updater.config.json \
    NODE_ENV=production
VOLUME ["/config"]
# Unhealthy when the configuration or the variables it refers to are broken.
HEALTHCHECK --interval=5m --timeout=30s --start-period=10s CMD ["self-updater", "validate"]
ENTRYPOINT ["/sbin/tini", "--", "self-updater"]
CMD ["start"]
