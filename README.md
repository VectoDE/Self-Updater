# 🚀 Self-Updater 2.0

Enterprise-grade GitOps automation for PM2, Docker, and custom service stacks. The self-updater monitors a Git repository, deploys new commits with zero-downtime safe guards, and restarts your runtime using hardened operational workflows.

## ✨ Highlights

- 🔐 **Production-ready configuration** with schema validation, hooks, jitter control, and optional API tokens.
- 📦 **Repository lifecycle management** – automatic cloning, fetch, reset, and dependency installation when `package.json` changes.
- 🧭 **Multi-platform restarts** supporting PM2, Docker, Docker Compose, and arbitrary commands.
- 🛰️ **Robust watcher** using GitHub/GitLab APIs with ETag caching and git fallback for air‑gapped environments.
- 🧾 **Structured logging** with optional file output and persistent deployment state tracking.
- 🛠️ **Operational tooling**: `run-once`, `status`, `validate`, PM2 ecosystem config, and container image.

## 📦 Installation

```bash
npm install -g self-updater
```

> **Note:** The CLI reads environment variables from a local `.env` file (if present) before loading configuration.

## ⚙️ Configuration

Initialize an enterprise configuration interactively via CLI:

```bash
self-updater init \
  --repo https://github.com/your-org/your-service.git \
  --branch main \
  --path /srv/your-service \
  --type pm2 \
  --name your-service \
  --interval 120 \
  --jitter 30 \
  --auto-install \
  --pre "npm run migrate" \
  --post "npm run health-check" \
  --log-level info
```

This produces `updater.config.json` (overridable via `SELF_UPDATER_CONFIG`). Example:

```json
{
  "version": 2,
  "repo": {
    "url": "https://github.com/your-org/your-service.git",
    "branch": "main",
    "remote": "origin",
    "authToken": "${GITHUB_TOKEN}"
  },
  "workspace": {
    "localPath": "/srv/your-service",
    "autoInstall": true,
    "installCommand": "npm ci"
  },
  "service": {
    "type": "pm2",
    "name": "your-service"
  },
  "schedule": {
    "intervalSeconds": 120,
    "jitterSeconds": 30
  },
  "hooks": {
    "preUpdate": "npm run migrate",
    "postUpdate": "npm run health-check"
  },
  "logging": {
    "level": "info",
    "file": "/var/log/self-updater/agent.log"
  }
}
```

### Supported service targets

| Type     | Behaviour                                                                                           |
|----------|------------------------------------------------------------------------------------------------------|
| `pm2`    | Runs `pm2 reload <name>` unless `restartCommand` is provided.                                        |
| `docker` | Runs `docker restart <name>` or `docker compose [-f file] restart <service>` when `dockerCompose` is enabled. |
| `command`| Executes a fully custom `restartCommand` (required).                                                 |

### Hooks & automation

- `preUpdate` executes inside the workspace **before** the git reset.
- `postUpdate` runs **after** service restart for smoke tests or cache warmups.
- `autoInstall` triggers dependency installs when lock files change (`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`).

### Logging & state

- Log level: `error`, `warn`, `info`, or `debug` (default `info`).
- Optional `logging.file` enables structured log files with automatic directory creation.
- Deployment state persists in `updater.state.json` alongside the config for auditability.

## 🧰 CLI Commands

| Command | Description |
|---------|-------------|
| `self-updater init` | Create or update `updater.config.json`. |
| `self-updater start [--immediate]` | Start the continuous watcher loop (suitable for PM2/systemd). |
| `self-updater run-once` | Perform a single update cycle and exit (CI/CD or cron). |
| `self-updater status` | Display local vs remote commit along with the last deployment timestamp. |
| `self-updater validate` | Lint the configuration and exit non-zero on failure. |

## 🏃 Runtime options

Environment variables override defaults at runtime:

- `SELF_UPDATER_CONFIG` – absolute path to the config file (default: `<cwd>/updater.config.json`).
- `SELF_UPDATER_LOG_LEVEL` – force log level without rewriting the config.

A `.env` file placed next to the binary will be loaded prior to reading configuration, ideal for injecting tokens (e.g., `GITHUB_TOKEN`).

## ☸️ Container deployment

A hardened multi-stage Dockerfile is included. Build and run:

```bash
docker build -t self-updater .
docker run -d \
  --name self-updater \
  -v /srv/self-updater/config:/config \
  -v /srv/your-service:/srv/your-service \
  self-updater
```

Place your `updater.config.json` inside `/srv/self-updater/config`. The container entrypoint executes `node bin/cli.js start --immediate`.

## ♻️ PM2 integration

Use the supplied `ecosystem.config.cjs` template:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status self-updater
```

Logs default to `./logs/out.log` and `./logs/error.log`; customize paths as needed.

## 🛡️ Operational guarantees

- File-lock based concurrency guard prevents overlapping deployments.
- Git operations use safe `fetch + hard reset` to ensure clean trees.
- Automatic fallback to `git ls-remote` when API quota or connectivity issues occur.
- Dependency install and hook execution are fully logged for traceability.

## 🧪 Development

```bash
npm install
npm run build
npm link
self-updater --help
```

## 📄 License

Apache 2.0 License © 2025 VectoDE

## 💬 Support

Open an issue or feature request at [github.com/VectoDE/self-updater/issues](https://github.com/VectoDE/self-updater/issues)
