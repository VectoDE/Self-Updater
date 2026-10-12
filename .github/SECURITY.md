# Security policy

## Supported versions

| Version                        | Supported                                                         | Security updates until           |
| ------------------------------ | ----------------------------------------------------------------- | -------------------------------- |
| 4.x (`@vectode/self-updater`)  | Yes. Fixes ship in a new patch or minor release of the latest 4.x | 6 months after 5.0.0 is released |
| 3.x and older (`self-updater`) | No. Move to `@vectode/self-updater`; the README shows how.        | Ended with the release of 4.0.0  |

- Only the latest release of a major version is supported; there are no backports to older minor or patch releases.
  Upgrading within a major version is always safe, because breaking changes only come with a new major version.
- When a new major version comes out, the previous one keeps getting security fixes for six months. The end date is
  added to this table and announced in the changelog and the release notes of the new major version.
- After that date the old major version gets no updates of any kind, security fixes included.

## Reporting a vulnerability

Do not open a public issue. Report privately through
[GitHub Security Advisories](https://github.com/VectoDE/Self-Updater/security/advisories/new).

Please include the affected version, the relevant part of your configuration (without secrets), the steps or request
that show the problem, and the impact as you see it.

## What happens next

1. You get an answer within 7 days that confirms the report or asks for details.
2. The maintainer reproduces the problem in a private advisory and agrees on a severity with you (CVSS).
3. The fix is developed in the advisory's private fork, with a regression test, and released as a patch version.
   Medium and higher issues are fixed within 60 days, critical ones as fast as possible.
4. The advisory is published with a CVE where one applies, and the changelog lists the fix under "Security".
5. You are credited in the advisory and the changelog, unless you prefer to stay anonymous.

## What counts as a vulnerability

- A webhook delivery without the right signature or token that starts an update, or any way to choose what gets
  deployed through the webhook
- A token, webhook secret or notification URL that shows up in logs, error messages, notifications, `.git/config`
  or the process list
- Code from a ref other than the tracked branch or a matching tag being deployed, or an unsigned commit or tag being
  deployed while `track.requireSignature` is on
- Command injection through values that do not come from the operator's own configuration (repository content,
  branch or tag names, webhook payloads)
- Two updaters deploying into the same workspace at the same time despite the lock

## Not a vulnerability

- Commands in your own configuration: hooks, the install command, a custom restart or health command run with the
  rights of the updater by design. Whoever can edit the configuration file can run code.
- Code in the repository you deploy. The updater checks out and installs what the tracked branch or tag contains;
  protect that branch, and turn on `track.requireSignature` if you want to deploy only signed releases.
- A webhook port reachable from the internet without TLS. Put it behind a reverse proxy with HTTPS; the HMAC
  signature still protects against forged deliveries.

## What you can expect

The [security assurance case](../docs/ASSURANCE.md) explains the threat model, the trust boundaries and how common
weaknesses are countered. In short: Git and built-in restarts run without a shell, tokens travel in a scoped HTTP
header through the environment, webhook deliveries are checked in constant time before anything is parsed, and the
package has no runtime dependencies.

## Verifying a release

`@vectode/self-updater` is built and published only by the [release workflow](workflows/release.yml), never from a
laptop.

- **npm:** every version carries a signed SLSA provenance statement that names this repository, the workflow and the
  commit. Check the installed packages with `npm audit signatures`, or look for "Provenance" on
  [npmjs.com](https://www.npmjs.com/package/@vectode/self-updater).
- **GitHub releases:** each release has the package tarball, its signed build attestation (`.intoto.jsonl`) and a
  CycloneDX software bill of materials (`.cdx.json`) attached. Verify a downloaded tarball with the GitHub CLI:

  ```bash
  gh attestation verify vectode-self-updater-<version>.tgz --repo VectoDE/Self-Updater
  ```

- **Container image:** `ghcr.io/vectode/self-updater` carries a build attestation as well:

  ```bash
  gh attestation verify oci://ghcr.io/vectode/self-updater:<version> --repo VectoDE/Self-Updater
  ```

- **Git tags:** release commits and version tags are signed with the release SSH key, whose public half is in
  [allowed_signers](allowed_signers). GitHub shows them as verified; in a clone, check a tag with:

  ```bash
  git -c gpg.ssh.allowedSignersFile=.github/allowed_signers tag --verify v<version>
  ```

The old npm package `self-updater` (3.0.0 and older) was published by hand and has no provenance.

## Vulnerabilities in dependencies

The package has no runtime dependencies, so a vulnerability in a dependency can only affect development, CI or the
container base image. Dependabot, OSV-Scanner and `npm audit` report them on every pull request, and they are fixed
by updating. When a reported vulnerability does not affect the project and cannot be updated away, the project
publishes an [OpenVEX](https://openvex.dev/) statement in `.vex/` that explains why it is not exploitable, and links
it from the release notes. There are no such statements today.

## Secrets and credentials

- The project keeps as few secrets as possible. npm publishing uses OIDC Trusted Publishing, and workflows use the
  short-lived `GITHUB_TOKEN`; neither is stored anywhere.
- The only stored secrets are two SSH keys for the release commit: `RELEASE_DEPLOY_KEY` pushes it past the main
  ruleset, and `RELEASE_SIGNING_KEY` signs the commit and the version tag. They are secrets of the GitHub environment
  `release`, which only `main` can use, so workflows on other branches never see them. One job that runs no
  dependency code uses them, and no person keeps a copy.
- Secrets are never committed, logged or passed on the command line. gitleaks in CI and GitHub secret scanning with
  push protection block leaks.
- Secrets are rotated once a year, when a maintainer with access leaves, and immediately on any suspicion of
  exposure: generate a new key, replace the deploy key or signing key and the secret (and `allowed_signers` for the
  signing key), then delete the old key.
- Access to secrets is listed in the [governance](GOVERNANCE.md#access-to-sensitive-resources) document.
