# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

The package is now `@vectode/self-updater`. It was rewritten in TypeScript and has no runtime dependencies. Run
`self-updater migrate` to convert an existing configuration; the README lists everything that changed.

### Added

- Health check after the restart, by URL, by command or both, with retries.
- Automatic rollback to the previous commit when install, restart, health check or post-update hook fail. A failed
  commit is skipped until a newer one arrives; `update --force` deploys it anyway.
- Tag mode: deploy the newest SemVer tag matching a pattern, with or without prereleases.
- Signature check: deploy only commits or tags with a valid SSH or GPG signature (`track.requireSignature`).
- Webhook receiver for GitHub (HMAC-SHA256) and GitLab (secret token); deliveries during a running deployment lead to
  one more cycle.
- Notifications to Slack, Discord and generic JSON webhooks on success, failure and rollback.
- Service types `systemd` and `compose` (Docker Compose `up --build`), optional `sudo -n` for built-in restarts.
- Commands `rollback` and `migrate`; `update --dry-run`; `--json` output; exit code 3 after a rollback.
- Lock file, so two updaters never deploy into the same workspace at once.
- JSON log format; secrets are hidden in every log line. Hooks, the install command and custom restarts appear in
  logs and errors by their role only, because their text may contain credentials.
- `@vectode/self-updater/config`: the configuration format without Node.js APIs, used by the new
  [configuration builder](https://vectode.github.io/Self-Updater/).
- Container image `ghcr.io/vectode/self-updater` for amd64 and arm64, running as a non-root user.
- Examples for PM2, Docker Compose and a systemd setup with signed tags.

### Changed

- Configuration format version 3. Versions 1 and 2 still load and are converted by `self-updater migrate`.
- Requires Node.js 22 or newer.
- PM2 restarts use `pm2 reload --update-env`.
- The access token is sent as an HTTP header through the environment of each Git call instead of being written into
  the remote URL.
- Dependencies are installed only when a lockfile or `package.json` changed, by default with `npm ci`.

### Removed

- The runtime dependencies `axios`, `simple-git`, `commander` and `pm2`.

### Security

- Git and built-in restarts run without a shell; branch, remote and service names are validated.
- Releases are built by GitHub Actions and published with signed provenance to npm, as a GitHub release with build
  attestation and CycloneDX SBOM, to GitHub Packages and to the GitHub Container Registry.
- Security policy, assurance case, OpenSSF Scorecard, CodeQL, dependency review, OSV-Scanner and secret scanning.

## [3.0.0] - 2025-10-22

Published to npm as `self-updater` 3.0.0 from the 2.0 rewrite: configuration version 2, GitHub and GitLab API polling
with Git fallback, Docker Compose, hooks, `run-once`, `status` and `validate`. Not tagged in this repository.

## [1.0.1] - 2025-10-09

### Fixed

- Corrections to the first release.

## [1.0.0] - 2025-10-09

First release as `self-updater`.

[Unreleased]: https://github.com/VectoDE/Self-Updater/compare/v1.0.1...HEAD
[3.0.0]: https://www.npmjs.com/package/self-updater/v/3.0.0
[1.0.1]: https://github.com/VectoDE/Self-Updater/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/VectoDE/Self-Updater/releases/tag/v1.0.0
