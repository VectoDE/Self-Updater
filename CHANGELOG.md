# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Repository maintenance only; the package code is unchanged.

### Changed

- Dependabot no longer proposes Node.js majors for the container image; it moves to a new Node.js line on purpose,
  together with the CI matrix, once that line is LTS.

### Fixed

- CI: `reuse lint` passes on `.bestpractices.json`, and the webhook test for oversized bodies no longer fails with an
  unhandled `EPIPE` on macOS.

## [4.2.0] - 2026-10-13

### Added

- Several workspaces in one configuration file: a `workspaces` list with shared `defaults`, one webhook receiver for
  all of them that routes each delivery by repository and ref, a state file per workspace and `--workspace` (`-w`)
  for `update`, `status`, `rollback` and `start`.
- Blue-green deployments (`workspace.strategy: "blue-green"`): the next version is prepared in a second checkout
  while the old one runs, a symlink (a junction on Windows) switches between them, and a rollback only moves the link
  back.
- Status endpoint next to the webhook receiver (`webhook.statusPath`, `webhook.statusToken`) that reports what each
  workspace runs, for monitoring systems.
- The configuration builder offers the strategy and the status endpoint.

## [4.1.2] - 2026-10-13

### Added

- Every source file carries an SPDX license and copyright header; the rest is covered by `REUSE.toml`, and CI checks
  REUSE compliance.
- CI builds the npm package twice from separate clones and fails when the tarballs differ.
- Written code review standards in `CONTRIBUTING.md`.

## [4.1.1] - 2026-10-13

### Fixed

- An environment variable whose value contains `$${` is inserted unchanged. Before, the escape was resolved after
  substitution and the value lost a dollar sign (#23).

## [4.1.0] - 2026-10-13

### Changed

- The configuration builder moved to [self-updater.pages.dev](https://self-updater.pages.dev/), which sends a strict
  Content Security Policy, HSTS and the other security headers from `site/_headers`. The old GitHub Pages address
  forwards there.

## [4.0.1] - 2026-10-13

### Changed

- The container image builds Docker Compose with Go 1.27.2.

### Fixed

- Configuration builder: status messages are `<output>` elements, and the generated file wraps instead of scrolling,
  so it is readable without a keyboard-focusable scroll area.

## [4.0.0] - 2026-10-12

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
- The container image ships the Docker CLI from the official image and Docker Compose built from source with current
  Go and dependency fixes. One finding without a fix, GO-2026-5932, does not apply; see the
  [OpenVEX statement](.vex/self-updater.openvex.json).
- Webhook secrets need at least 32 characters, and GitLab tokens are compared without revealing their length.

## [3.0.0] - 2025-10-22

Published to npm as `self-updater` 3.0.0 from the 2.0 rewrite: configuration version 2, GitHub and GitLab API polling
with Git fallback, Docker Compose, hooks, `run-once`, `status` and `validate`. Not tagged in this repository.

## [1.0.1] - 2025-10-09

### Fixed

- Corrections to the first release.

## [1.0.0] - 2025-10-09

First release as `self-updater`.

[Unreleased]: https://github.com/VectoDE/Self-Updater/compare/v4.2.0...HEAD
[4.2.0]: https://github.com/VectoDE/Self-Updater/compare/v4.1.2...v4.2.0
[4.1.2]: https://github.com/VectoDE/Self-Updater/compare/v4.1.1...v4.1.2
[4.1.1]: https://github.com/VectoDE/Self-Updater/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/VectoDE/Self-Updater/compare/v4.0.1...v4.1.0
[4.0.1]: https://github.com/VectoDE/Self-Updater/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/VectoDE/Self-Updater/compare/v1.0.1...v4.0.0
[3.0.0]: https://www.npmjs.com/package/self-updater/v/3.0.0
[1.0.1]: https://github.com/VectoDE/Self-Updater/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/VectoDE/Self-Updater/releases/tag/v1.0.0
