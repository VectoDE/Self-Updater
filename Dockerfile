# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY scripts ./scripts
COPY bin ./bin
COPY src ./src

RUN npm ci && npm run build

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

RUN npm ci --omit=dev && npm cache clean --force

VOLUME ["/config"]

ENV SELF_UPDATER_CONFIG=/config/updater.config.json

ENTRYPOINT ["node", "bin/cli.js"]
CMD ["start", "--immediate"]
