# Security assurance case

Why the security requirements of Self-Updater are met. It covers the threat model, the trust boundaries, how secure
design principles are applied and how common weaknesses are countered.

## Security requirements

1. Only code from the configured repository is deployed: the newest commit of the tracked branch, or the newest tag
   matching the pattern. With `track.requireSignature`, only code with a valid signature from an allowed key.
2. Nobody without the webhook secret can start an update through the webhook, and no delivery can choose what is
   deployed.
3. Tokens, webhook secrets and notification URLs never appear in logs, error messages, notifications, `.git/config`,
   command-line arguments or the state file.
4. Values that do not come from the operator's configuration (branch and tag names from the remote, webhook payloads,
   API answers) cannot inject commands or options into Git or the restart.
5. A failed deployment leaves a working service behind when rollback is on, and two updaters never deploy into the
   same workspace at once.
6. Installing and updating the package cannot run third-party code.

## Threat model

| Actor                                                                         | Goal                                                      | Requirement |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| Anyone who can reach the webhook port                                         | Trigger deployments, flood the server, deploy another ref | 2           |
| Attacker with push access to another ref                                      | Get an unreviewed branch or tag deployed                  | 1           |
| Attacker who controls a compromised mirror or account without the signing key | Deploy modified code                                      | 1           |
| Reader of logs, chat channels or CI output                                    | Collect access tokens and webhook URLs                    | 3           |
| Author of crafted branch or tag names                                         | Inject Git options or shell commands                      | 4           |
| A broken commit                                                               | Take the service down                                     | 5           |
| Attacker in the supply chain                                                  | Ship modified code to users of the package                | 6           |

Out of scope: the operator's own configuration. Hooks, the install command and custom restart and health commands run
with the updater's rights by design, so whoever can write the configuration file can run code. The code in the
deployed repository is trusted in the same way; protecting its branch is the job of the Git host, and
`track.requireSignature` adds a check that does not depend on it.

## Trust boundaries

- **The configuration file and `.env`** come from the operator and are trusted. They are still validated completely
  before anything runs (`self-updater validate`), so mistakes fail early with the path of the field.
- **Webhook requests** come from the network and are untrusted. The body is limited to 1 MB, the GitHub HMAC or
  GitLab token is compared in constant time before the payload is parsed, and the payload only decides whether a
  cycle starts. The target is then resolved from the repository like in a poll.
- **The remote repository and provider API** are trusted for content but not for names: refs are passed to Git as
  separate arguments after `--` or in a full refspec, API answers are accepted only if they are a commit id, and
  branch, remote and service names in the configuration are checked against strict patterns.
- **Child processes** get a time limit and are stopped with their whole process tree when they exceed it. Their output
  is capped at 1 MB and redacted before it is logged.
- **The platform** (Node.js, Git, OpenSSH or GnuPG, the service manager) is trusted.

## Secure design principles

- **Economy of mechanism:** no runtime dependencies. Git does the transport and signature checks, Node's built-in
  modules do the rest.
- **Fail-safe defaults:** the webhook only listens on 127.0.0.1 and cannot start without a secret of at least 16
  characters; a commit that failed is not retried on its own; rollback is on; a signature failure stops the
  deployment before anything changes.
- **Least privilege:** the systemd example runs as an unprivileged user with a read-only system, the container image
  runs as `node`, and `sudo -n` is used only for the restart command when asked for. The token is scoped to the
  repository's origin through `http.<origin>.extraHeader`, so Git sends it nowhere else, and configured credential
  helpers are switched off while it is set. CI jobs get read-only tokens unless a step needs more; the keys that push
  and sign release commits are secrets of an environment that only `main` can use, read by one job that runs no
  dependency code.
- **Complete mediation:** every cycle resolves the target again and checks the lock, the failed commit and the
  signature; nothing is cached across cycles except the API ETag.
- **Open design:** all code, tests and the release process are public; security does not rely on hidden details.

## Common weaknesses countered

| Weakness                                   | Countermeasure                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| CWE-78 OS command injection                | Git and built-in restarts are argument lists without a shell; names are validated; only operator commands use the shell      |
| CWE-88 argument injection                  | Refs are passed after `--` or as full refspecs; URLs starting with `-` are rejected                                          |
| CWE-532 secrets in log files               | The logger replaces every configured secret, also in JSON-escaped form; property-based tests try arbitrary secrets           |
| CWE-214 secrets in process arguments       | The token travels through `GIT_CONFIG_*` environment variables, never in argv or the remote URL                              |
| CWE-345 insufficient verification          | `git verify-commit` / `verify-tag` with an allowed signers file before checkout                                              |
| CWE-290 / CWE-208 webhook spoofing, timing | HMAC-SHA256 or token compared with `timingSafeEqual`                                                                         |
| CWE-400 resource exhaustion                | 1 MB body limit, request and header timeouts, one running cycle with coalesced triggers, output caps, time limits            |
| CWE-362 race conditions                    | Exclusive lock file created with `wx`, owner check before release, stale locks only taken over once                          |
| CWE-732 permissions                        | Configuration and state are written with mode 0600 through a temporary file and an atomic rename                             |
| CWE-1357 untrusted components              | Zero runtime dependencies; dev dependencies pinned in the lockfile, scanned by Dependabot, OSV-Scanner and dependency review |
| CWE-494 download without integrity         | Releases are built in GitHub Actions and published with signed SLSA provenance and GitHub attestations                       |

## Evidence

- Tests and coverage: `npm run test:coverage` (thresholds in `vitest.config.ts`). Deployments, rollbacks, tag mode
  and SSH signatures are tested against real Git repositories in `test/updater.test.ts` and `test/git.test.ts`;
  webhook authentication in `test/webhook.test.ts`; property-based tests for redaction, signatures and parsing in
  `test/properties.test.ts`.
- Static analysis: CodeQL and SonarQube Cloud on every pull request, ESLint with `--max-warnings 0`.
- Supply chain: [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/VectoDE/Self-Updater), pinned
  actions and base image, provenance on npm and attestations for the container image.
