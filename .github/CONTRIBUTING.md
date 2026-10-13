# Contributing

Thanks for helping. Bug reports, fixes, new service types, notification targets and documentation improvements are
welcome.

## Before you start

- Security problems go through the [security policy](SECURITY.md), not through issues.
- For new configuration options or public API, open an issue first so we can agree on names and behaviour.

## Setup

```bash
git clone https://github.com/VectoDE/Self-Updater.git
cd Self-Updater
npm ci
npm test
```

Node.js 22 or newer and Git 2.34 or newer are required (`.nvmrc` pins 24). The integration tests create real Git
repositories in the temp directory and run `git` and `ssh-keygen` from `PATH`.

| Command                 | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `npm test`              | Runs the test suite once                                              |
| `npm run test:coverage` | Tests with coverage; fails below the thresholds                       |
| `npm run build`         | Builds ESM, CommonJS, types and the CLI into `dist/`                  |
| `npm run dev:site`      | Serves the configuration builder on http://localhost:5173             |
| `npm run check`         | Everything CI runs: lint, format, types, tests, build, package checks |

## Layout

- `src/config/schema.ts` and `src/semver.ts` are isomorphic: no Node APIs, so the configuration builder on the
  website validates with the same code (`@vectode/self-updater/config`).
- `src/updater.ts` runs one update cycle; `src/agent.ts` schedules cycles and starts the webhook server.
- `src/git.ts`, `src/exec.ts`, `src/service.ts`, `src/health.ts`, `src/notify.ts` and `src/lock.ts` are the steps
  of a deployment. `src/cli/` is the `self-updater` command.
- `site/` is the configuration builder for GitHub Pages, `examples/` holds ready-made configurations.

## Making a change

1. Branch from `main`: `fix/short-name` or `feat/short-name`.
2. Add or update tests. A bug fix comes with a test that fails without it. Deployment behaviour is tested against
   real Git repositories (see `test/helpers.ts`), not mocks.
3. Document configuration and public API in the README and with TSDoc; add an entry under "Unreleased" in
   `CHANGELOG.md`.
4. Run `npm run check`.

## Coding standards

CI enforces all of these; `npm run check` runs the same checks locally.

- TypeScript in strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noImplicitOverride`.
- ESLint with typescript-eslint `strictTypeChecked` and `stylisticTypeChecked` plus `eslint-plugin-sonarjs`. No
  warnings are allowed (`--max-warnings 0`), and rules are only switched off in `eslint.config.js` with a comment
  that says why.
- Prettier formats every file; do not format by hand.
- Git and built-in service commands run as argument lists without a shell. Only commands the operator writes into
  the configuration (hooks, install, custom restart, health command) go through the shell.
- Tokens, webhook secrets and notification URLs never reach logs, error messages or notifications: pass them to the
  logger as secrets.
- Errors that callers handle are `SelfUpdaterError` with a `code`. Comments explain why, not what.
- Coverage stays above the thresholds in `vitest.config.ts`.

## Dependencies

- **Runtime:** none. The package uses Node's built-in modules and the `git` binary, and a runtime dependency needs an
  issue that explains why it cannot be avoided.
- **Development:** chosen for being widely used, actively maintained, permissively licensed and published with npm
  provenance where available. Added with `npm install -D --save-exact`, so versions are exact, and locked with
  integrity hashes in `package-lock.json`. CI installs only with `npm ci --ignore-scripts`.
- **GitHub Actions and container images:** pinned to a full commit SHA or digest with the version in a comment.
- **Tracking:** Dependabot opens weekly update pull requests for npm, Actions and the Docker base image (patch and
  minor ones merge on their own once every check passes) and security updates as soon as an advisory appears.
  Dependency review, OSV-Scanner and `npm audit` check every pull request.

## Commits and pull requests

- Write commit messages in English, imperative mood, and explain why: `Skip the install when no lockfile changed`.
- Sign off every commit (`git commit -s`). The sign-off certifies the
  [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or have the right to
  submit it under the project's license. A check on every pull request rejects commits without a matching
  `Signed-off-by` line.
- One topic per pull request. Fill in the template.
- CI must be green before review.

## Code review

Every change reaches `main` through a pull request, and only a maintainer merges it. The reviewer reads the whole diff
and checks it against this list before approving:

1. **Purpose.** The pull request says what it changes and why, and links the issue it closes. It does one thing.
2. **Correctness.** The code does what the description says, including the failure paths: a failed `git`, install,
   restart or health check leaves the workspace on a known commit, and the state file stays consistent.
3. **Tests.** New behaviour and every fixed bug have a test that fails without the change. Coverage stays above the
   thresholds.
4. **Security.** Input from configuration files, webhooks and the environment is validated; nothing passes it to a
   shell; secrets never reach logs, errors or notifications; webhook signatures are compared in constant time. Changes
   to these areas get a second look at `docs/ASSURANCE.md`, which must still be true afterwards.
5. **Dependencies.** No runtime dependency. A new development dependency is justified in the description and pinned.
6. **Compatibility.** A change to the configuration format, the CLI or the public API is either backwards compatible
   or labelled `breaking-change` with migration notes.
7. **Documentation.** README, `CHANGELOG.md` (under "Unreleased") and the configuration builder match the change.
8. **Style.** The checks enforce formatting and lint rules; the reviewer looks at names, comments that explain why, and
   new files carrying the SPDX header.

The reviewer leaves a comment for each point that fails and approves only when none is left. Changes by the maintainer
go through the same checks, and CI runs them on every pull request.

## Releases

Every change merged into `main` is released on its own: `.github/workflows/release.yml` checks it again, raises the
version, moves the "Unreleased" notes into a new `CHANGELOG.md` section, tags the release commit and publishes the
package as a GitHub release with a signed build attestation, to npm with provenance, to GitHub Packages and as a
container image to the GitHub Container Registry.

- The version step comes from the pull request labels: `breaking-change` makes a major release, `enhancement` a minor
  one, anything else a patch. Without a pull request, `BREAKING CHANGE` in a commit message or a `feat:` subject do
  the same.
- Put `[skip release]` in a commit message to leave it out, for example for a typo in the README.
- To choose the step yourself, run the Release workflow by hand.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](../LICENSE).

Every new source file starts with the SPDX header that the other files carry; the `reuse` check in CI fails without
it. Add it with `reuse annotate --copyright "Vecto <https://github.com/VectoDE>" --license Apache-2.0 <file>`. Files
that cannot hold a comment, such as JSON and Markdown, are covered by `REUSE.toml`.
