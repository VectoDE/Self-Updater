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

FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
LABEL org.opencontainers.image.source="https://github.com/VectoDE/Self-Updater" \
      org.opencontainers.image.description="Keeps a server checkout in sync with its Git repository" \
      org.opencontainers.image.licenses="Apache-2.0"
# git and ssh for the repository, the Docker CLI with compose for the docker and compose service types, tini to
# forward signals so a running deployment can finish before the container stops.
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose tini
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
