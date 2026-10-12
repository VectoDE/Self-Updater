# Self-Updater

[![CI](https://github.com/VectoDE/Self-Updater/actions/workflows/ci.yml/badge.svg)](https://github.com/VectoDE/Self-Updater/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/VectoDE/Self-Updater/badge)](https://scorecard.dev/viewer/?uri=github.com/VectoDE/Self-Updater)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=VectoDE_Self-Updater&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=VectoDE_Self-Updater)
[![npm](https://img.shields.io/npm/v/@vectode/self-updater)](https://www.npmjs.com/package/@vectode/self-updater)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Keeps a server checkout in sync with its Git repository. When the tracked branch gets a new commit, or a new release
tag appears, Self-Updater fetches it, installs dependencies if they changed, restarts the service, checks that it
works and goes back to the previous commit if it does not.

It runs on the server itself, so it needs no inbound access from a CI system and no deploy credentials outside the
machine. Polling works behind any firewall; a GitHub or GitLab webhook makes it react within seconds.

- Restarts PM2 processes, systemd units, Docker containers, Docker Compose services or any command
- Health check by URL or command, automatic rollback, and a commit that failed is not retried until a newer one arrives
- Follows a branch or the newest SemVer tag, and can refuse commits or tags without a valid signature
- Webhook receiver with GitHub HMAC signatures and GitLab tokens
- Notifications to Slack, Discord or any JSON webhook
- No runtime dependencies: Node.js 22 or newer and Git are all it needs

Write a configuration in the browser with the [configuration builder](https://vectode.github.io/Self-Updater/). It
checks the file with the same code the updater runs.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How an update runs](#how-an-update-runs)
- [Configuration](#configuration)
- [Commands](#commands)
- [Run it permanently](#run-it-permanently)
- [Webhooks](#webhooks)
- [Signed releases only](#signed-releases-only)
- [Use it from code](#use-it-from-code)
- [Upgrading from self-updater 1.x to 3.x](#upgrading-from-self-updater-1x-to-3x)
- [Security](#security)

## Install

```bash
npm install --global @vectode/self-updater
```

Requirements: Node.js 22 or newer, Git 2.34 or newer (for SSH signatures; plain updates work with older versions).
Linux, macOS and Windows are tested in CI.

A container image is published as `ghcr.io/vectode/self-updater`; see [Run in a container](#run-in-a-container).

## Quick start

```bash
cd /etc/self-updater
self-updater init --repo https://github.com/acme/shop.git --path /srv/shop --type pm2 --name shop \
  --install --health-url http://127.0.0.1:3000/health --token-env GITHUB_TOKEN
echo "GITHUB_TOKEN=github_pat_..." > .env && chmod 600 .env
self-updater update      # first deployment: clones into /srv/shop, installs, restarts, checks
self-updater start       # keeps running and polls every 60 seconds
```

`init` writes `updater.config.json`. The token stays out of the file: the configuration refers to `${GITHUB_TOKEN}`,
and the value comes from the environment or from a `.env` file next to the configuration.

## How an update runs

Each cycle compares the deployed commit with the remote. When they differ:

1. **Fetch** the new commit (only the tracked branch or tag).
2. **Verify** its signature, when `track.requireSignature` is on.
3. **Pre-update hook.** If it fails, the update stops and nothing has changed.
4. **Check out** the new commit.
5. **Install** dependencies, when `workspace.install` is on and a lockfile or manifest changed.
6. **Restart** the service.
7. **Health check**, when one is configured.
8. **Post-update hook.**

If step 5, 6, 7 or 8 fails and `rollback.enabled` is on, the previous commit is checked out, installed if needed,
restarted and checked again. The failed commit is remembered in `updater.state.json` and skipped until a newer commit
arrives or you run `self-updater update --force`.

A lock file in `.git/` keeps two updaters from deploying into the same workspace at once. `start` never stops in the
middle of a deployment: on SIGINT or SIGTERM it finishes the running cycle first.

## Configuration

`updater.config.json` is found through `--config`, then the `SELF_UPDATER_CONFIG` environment variable, then the
current directory. Relative paths in it are relative to the file. Values can refer to environment variables with
`${NAME}` or `${NAME:-default}` (a default cannot contain `$` or `}`); write `$${` for a literal `${`. A `.env` file next to the configuration is loaded
first and never overrides variables that are already set.

A full example for PM2 ([more in `examples/`](examples/)):

```json
{
  "version": 3,
  "repo": { "url": "https://github.com/acme/api.git", "branch": "main", "token": "${GITHUB_TOKEN}" },
  "workspace": { "path": "/srv/api", "install": { "enabled": true, "command": "npm ci --omit=dev" } },
  "service": { "type": "pm2", "name": "api" },
  "hooks": { "preUpdate": "npm run db:backup", "postUpdate": "npm run cache:warm" },
  "healthCheck": { "url": "http://127.0.0.1:3000/health", "startDelaySeconds": 2 },
  "schedule": { "intervalSeconds": 120, "jitterSeconds": 30 },
  "notifications": [{ "type": "slack", "url": "${SLACK_WEBHOOK_URL}", "events": ["failure", "rollback"] }]
}
```

Only `repo.url`, `workspace.path` and `service.type` are required. `self-updater validate` lists every problem at
once, with the path of the field.

### `repo`

| Field      | Default    | Description                                                                                 |
| ---------- | ---------- | ------------------------------------------------------------------------------------------- |
| `url`      | (required) | HTTPS, SSH (`git@host:owner/repo.git`) or a local path                                      |
| `branch`   | `main`     | Branch to follow in branch mode                                                             |
| `remote`   | `origin`   | Name of the remote in the workspace                                                         |
| `token`    |            | Access token for HTTPS, e.g. `${GITHUB_TOKEN}`; sent as an HTTP header, never stored in Git |
| `provider` | `auto`     | `github`, `gitlab` or `git`; `auto` detects github.com and hosts containing "gitlab"        |
| `apiUrl`   |            | API base for GitHub Enterprise (`https://host/api/v3`) or self-hosted GitLab (`.../api/v4`) |

For GitHub and GitLab, branch heads are read through the provider API with conditional requests, so an unchanged
branch costs one cheap request per poll (GitHub does not count HTTP 304 answers against the rate limit). Any other
host, or an API error, falls back to `git ls-remote`.

GitHub tokens need read access to the repository contents (a fine-grained token with "Contents: read" is enough);
GitLab tokens need `read_repository` and `read_api`.

### `track`

| Field              | Default  | Description                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------- |
| `mode`             | `branch` | `branch` deploys the newest commit of `repo.branch`; `tag` deploys the newest tag |
| `tagPattern`       | `v*`     | Tags to consider in tag mode; `*` is the only wildcard                            |
| `prerelease`       | `false`  | Consider tags such as `v2.0.0-rc.1`                                               |
| `requireSignature` | `false`  | Deploy only commits (branch mode) or tags (tag mode) with a valid signature       |
| `allowedSigners`   |          | SSH allowed signers file for `requireSignature`                                   |

In tag mode the newest version wins by SemVer order, not by date: `v1.10.0` is newer than `v1.9.0`, and a hotfix
`v1.4.2` tagged after `v2.0.0` does not replace it.

### `workspace`

| Field             | Default    | Description                                                                                                        |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `path`            | (required) | Directory of the deployed checkout; created on the first run                                                       |
| `shallow`         | `false`    | Fetch only the target commit. Saves space, but the install step cannot see changes                                 |
| `install.enabled` | `false`    | Run the install command                                                                                            |
| `install.command` | `npm ci`   | Install command, run in the workspace                                                                              |
| `install.when`    | `changed`  | `changed` runs it when a watched file changed, `always` after every update                                         |
| `install.watch`   | lockfiles  | `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb` |

The workspace must be empty or an existing Git checkout. Local changes in it are overwritten: the deployed state is
always exactly the commit from the repository.

### `service`

| Type      | Restart                                                                          | Needs                      |
| --------- | -------------------------------------------------------------------------------- | -------------------------- |
| `pm2`     | `pm2 reload <name> --update-env`                                                 | `name`                     |
| `systemd` | `systemctl restart <name>`                                                       | `name`                     |
| `docker`  | `docker restart <name>`                                                          | `name`                     |
| `compose` | `docker compose [-f composeFile] up --detach --build --remove-orphans <service>` | `composeService` or `name` |
| `command` | your `command`, through the shell                                                | `command`                  |
| `none`    | nothing                                                                          |                            |

`command` also replaces the built-in restart of the other types. `sudo: true` prefixes built-in restarts with
`sudo -n`, for example for a systemd unit; allow exactly that command in sudoers:

```text
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart shop.service
```

### `hooks`

| Field            | Default | Description                                                          |
| ---------------- | ------- | -------------------------------------------------------------------- |
| `preUpdate`      |         | Runs before the checkout; a failure cancels the update               |
| `postUpdate`     |         | Runs after a successful restart and health check                     |
| `timeoutSeconds` | `600`   | Time limit for every command (hooks, install, restart, health check) |

Hooks and other configured commands run in the workspace through the shell (`/bin/sh`, or `cmd.exe` on Windows). A
command that runs too long is stopped together with its child processes.

### `healthCheck`

| Field               | Default | Description                                      |
| ------------------- | ------- | ------------------------------------------------ |
| `url`               |         | Must answer with `expectStatus`                  |
| `command`           |         | Must exit with 0                                 |
| `expectStatus`      | `200`   | Expected HTTP status; redirects are not followed |
| `timeoutSeconds`    | `10`    | Per attempt                                      |
| `retries`           | `5`     | Further attempts after the first one             |
| `intervalSeconds`   | `5`     | Wait between attempts                            |
| `startDelaySeconds` | `0`     | Wait before the first attempt                    |

Set `url`, `command` or both. Without a `healthCheck` section, a successful restart counts as success.

### `rollback`

`{ "enabled": true }` by default. Turn it off to keep a failed version running for inspection.

### `schedule` and `webhook`

| Field                      | Default               | Description                                                                 |
| -------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `schedule.enabled`         | `true`                | Poll the repository                                                         |
| `schedule.intervalSeconds` | `60`                  | Poll interval, at least 15                                                  |
| `schedule.jitterSeconds`   | `0`                   | Random extra delay per poll, so many servers do not poll at the same second |
| `webhook.enabled`          | `false`               | Start the webhook receiver                                                  |
| `webhook.host`             | `127.0.0.1`           | Address to listen on                                                        |
| `webhook.port`             | `9000`                |                                                                             |
| `webhook.path`             | `/hooks/self-updater` |                                                                             |
| `webhook.secret`           |                       | Required when the webhook is on, at least 16 characters                     |

Polling can only be turned off while the webhook is on. Keeping both on is a good idea: polling catches deliveries
that got lost.

### `notifications`

A list of targets:

```json
"notifications": [
  { "type": "discord", "url": "${DISCORD_WEBHOOK_URL}", "events": ["failure", "rollback"] },
  { "type": "webhook", "url": "https://ops.example.com/deployments" }
]
```

`type` is `slack`, `discord` or `webhook` (the full event as JSON). `events` defaults to all three: `success`,
`failure` and `rollback`. A failed notification is logged and never fails the deployment. Webhook URLs contain
credentials, so use `${NAME}`; they never appear in logs.

### `logging`

| Field    | Default | Description                            |
| -------- | ------- | -------------------------------------- |
| `level`  | `info`  | `error`, `warn`, `info` or `debug`     |
| `format` | `text`  | `text` or `json` (one object per line) |
| `file`   |         | Also append every line to this file    |

`SELF_UPDATER_LOG_LEVEL=debug` overrides the level for one run. Tokens, webhook secrets and notification URLs are
replaced with `***` in every line.

## Commands

| Command                                        | What it does                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `self-updater init --repo … --path … --type …` | Writes a configuration; `self-updater init --help` lists every option   |
| `self-updater start [--immediate]`             | Runs continuously: polls, listens for webhooks, deploys                 |
| `self-updater update [--force] [--dry-run]`    | One update cycle (alias `run-once`), for cron or CI                     |
| `self-updater status`                          | Deployed commit, remote commit, last update                             |
| `self-updater rollback [--to <commit>]`        | Goes back to the commit before the last deployment, or to the given one |
| `self-updater validate`                        | Checks the configuration and lists every problem                        |
| `self-updater migrate`                         | Converts a 1.x or 2.x configuration file; keeps the original as `.bak`  |

Every command takes `--config <file>`, `--env-file <file>` and `--json` (machine-readable output and JSON logs).

Exit codes: `0` done (also "up to date" and "skipped"), `1` the deployment failed, `2` usage or configuration error,
`3` the deployment failed and was rolled back.

A manual `rollback` marks the newer commit as failed, so `start` does not deploy it again right away. Push a fix, or
run `self-updater update --force` when you want it back.

## Run it permanently

### systemd

[`examples/self-updater.service`](examples/self-updater.service) runs the agent as an unprivileged user with
systemd's sandboxing:

```bash
sudo cp examples/self-updater.service /etc/systemd/system/
sudo systemctl enable --now self-updater
journalctl -u self-updater -f
```

### PM2

[`examples/ecosystem.config.cjs`](examples/ecosystem.config.cjs) runs the agent next to the application it deploys:

```bash
pm2 start examples/ecosystem.config.cjs && pm2 save
```

### Run in a container

```bash
docker run -d --name self-updater --restart unless-stopped \
  -v /etc/self-updater:/config \
  -v /srv/shop:/srv/shop \
  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
  ghcr.io/vectode/self-updater:4
```

The image runs as the unprivileged `node` user and contains Git, OpenSSH, the Docker CLI and Docker Compose. The
socket is only needed for the `docker` and `compose` service types; access to it is equivalent to root on the host,
so only mount it on machines where that is acceptable. Paths in the configuration are paths inside the container.

## Webhooks

1. Turn the receiver on and keep the secret in the environment:

   ```json
   "webhook": { "enabled": true, "port": 9000, "secret": "${SELF_UPDATER_WEBHOOK_SECRET}" }
   ```

   Generate a secret with `openssl rand -hex 32`.

2. Put it behind your reverse proxy with HTTPS, for example in nginx:

   ```nginx
   location = /hooks/self-updater { proxy_pass http://127.0.0.1:9000; }
   ```

3. Add the webhook: on GitHub under Settings → Webhooks with content type `application/json`, the same secret and the
   "push" event (in tag mode also "releases"); on GitLab under Settings → Webhooks with the secret as "Secret token"
   and "Push events" or "Tag push events".

The receiver accepts at most 1 MB, checks the signature or token in constant time before it parses the payload, and only
reacts to pushes to the tracked branch or matching tags. A delivery never decides what gets deployed: it only starts a
cycle, which asks the repository for the target like a poll does. Several deliveries during a running deployment lead
to one more cycle, not one per delivery.

## Signed releases only

To deploy only what a trusted person signed, follow tags and require signatures:

```json
"track": { "mode": "tag", "tagPattern": "v*", "requireSignature": true, "allowedSigners": "./allowed_signers" }
```

`allowed_signers` lists the SSH keys that may sign, in Git's format:

```text
release@acme.example ssh-ed25519 AAAAC3Nza...
```

For GPG signatures leave `allowedSigners` out and import the public keys into the keyring of the user that runs the
updater. A tag without a valid signature is reported as a failed deployment and nothing changes on the server.

## Use it from code

```ts
import { loadConfig, Logger, statePathFor, Updater } from '@vectode/self-updater';

const { config, path } = loadConfig('/etc/self-updater/updater.config.json');
const updater = new Updater(config, { statePath: statePathFor(path), logger: new Logger({ format: 'json' }) });
const result = await updater.update();
console.log(result.outcome); // 'up-to-date' | 'skipped' | 'dry-run' | 'deployed' | 'rolled-back' | 'failed'
```

`@vectode/self-updater/config` contains only the configuration format (`parseConfig`, `migrateConfig`,
`defineConfig`, the types) and runs in browsers, Deno and Bun as well. ESM and CommonJS builds with type definitions
are included.

## Upgrading from self-updater 1.x to 3.x

The package moved from `self-updater` to `@vectode/self-updater`. The old package gets no more updates.

```bash
npm uninstall --global self-updater
npm install --global @vectode/self-updater
self-updater migrate --config /path/to/updater.config.json
self-updater validate --config /path/to/updater.config.json
```

`migrate` converts the flat 1.x format and the `version: 2` format, keeps the original as `updater.config.json.bak`,
and keeps the behaviour you had: the install command stays `npm install` and rollback stays off. Turn rollback on
with `"rollback": { "enabled": true }` once a health check is configured. A configuration that was not migrated still
loads; `start` warns about it.

What changed:

- `repo.authToken` is `repo.token`; `workspace.localPath` is `workspace.path`; `autoInstall` and `installCommand`
  moved to `workspace.install`; `service.restartCommand` is `service.command`; Docker Compose is its own service type.
- PM2 restarts use `pm2 reload --update-env`, so a process picks up changed environment variables.
- New: health checks, rollback, tag mode, signatures, webhooks, notifications, systemd, `rollback` and `migrate`.
- Node.js 22 or newer is required.

## Security

See the [security policy](.github/SECURITY.md) for supported versions and how to report a vulnerability, and the
[assurance case](docs/ASSURANCE.md) for the threat model. Releases are built by GitHub Actions with signed provenance;
the policy shows how to verify them.

Contributions are welcome: see [CONTRIBUTING](.github/CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE).
