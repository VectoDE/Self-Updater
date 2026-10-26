# SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
#
# SPDX-License-Identifier: Apache-2.0

# Container image of the self-updater agent: ghcr.io/vectode/self-updater
#
# The configuration lives in /config (updater.config.json, optional .env); the workspace it deploys is a mounted
# directory. For the docker and compose service types, mount /var/run/docker.sock and add the socket's group with
# --group-add. See "Run in a container" in the README.

# Base image pinned by digest; Dependabot proposes updates.
FROM node:24-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsdown.config.ts README.md LICENSE CHANGELOG.md ./
COPY src ./src
RUN npm run build && npm pack --ignore-scripts --pack-destination /tmp

# Docker Compose built from source with the current Go release and dependency fixes: the published binaries and the
# Alpine package carry known vulnerabilities. Cross-compiled on the build platform, so arm64 builds fast.
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS compose
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
WORKDIR /src
# docker/compose/go.mod pins Compose and newer fixes of its dependencies; go.sum makes the build check every module.
# Dependabot keeps both current.
COPY docker/compose/go.mod docker/compose/go.sum ./
RUN version="$(go list -m -f '{{.Version}}' github.com/docker/compose/v5)" \
    && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -mod=readonly \
      -ldflags "-w -X github.com/docker/compose/v5/internal.Version=$version" \
      -o /out/docker-compose github.com/docker/compose/v5/cmd

# The Docker CLI from the official image, which is rebuilt with each Go release.
FROM docker:29.9.2-cli-alpine3.24@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker-cli

FROM node:24-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
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
