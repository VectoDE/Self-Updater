# Architecture

How Self-Updater is put together: what each module does, how an update cycle runs and where the boundaries are. The
README describes the behaviour from the outside; this page is for people who change the code.

## Entry points

| Entry                          | File            | Runs on     | Contents                                                     |
| ------------------------------ | --------------- | ----------- | ------------------------------------------------------------ |
| `@vectode/self-updater`        | `src/index.ts`  | Node.js 22+ | `Updater`, `Agent`, `loadConfig`, logger, webhook, helpers   |
| `@vectode/self-updater/config` | `src/config.ts` | Anywhere    | Configuration schema, migration, SemVer helpers; no Node API |
| `self-updater` (bin)           | `src/cli.ts`    | Node.js 22+ | Signal handling around `runCli` in `src/cli/run.ts`          |

`tsdown.config.ts` builds the two library entries as ESM and CommonJS with type definitions, and the CLI as one ESM
file. `__VERSION__` is replaced with the version from `package.json` at build time.

## Modules

| Module             | Responsibility                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `config/schema.ts` | Types, defaults and validation of the configuration; migration from versions 1 and 2               |
| `config/load.ts`   | Finding and reading the file, `${NAME}` expansion, relative paths, atomic writes with mode 0600    |
| `semver.ts`        | Parsing and ordering version tags, tag patterns                                                    |
| `git.ts`           | The Git commands the updater needs, token header through the environment, signature checks         |
| `target.ts`        | What to deploy: branch head through the provider API (with ETag) or `ls-remote`, or the newest tag |
| `updater.ts`       | One update cycle with rollback, plus `status` and manual `rollbackTo`                              |
| `exec.ts`          | Child processes with time limits, process tree termination and capped output                       |
| `service.ts`       | Restart commands per service type                                                                  |
| `health.ts`        | URL and command checks with retries                                                                |
| `lock.ts`          | Exclusive lock file per workspace                                                                  |
| `state.ts`         | `updater.state.json`: last deployment, failed commit, history of 50 entries                        |
| `notify.ts`        | Slack, Discord and JSON webhook messages                                                           |
| `webhook.ts`       | HTTP receiver, signature and token checks, ref filter                                              |
| `agent.ts`         | Schedule, webhook triggers, one cycle at a time, graceful stop                                     |
| `logger.ts`        | Text and JSON lines, secret redaction, optional log file                                           |
| `cli/run.ts`       | Argument parsing, `.env` loading, commands and exit codes                                          |

## One update cycle

`Updater.update()` in `src/updater.ts`:

1. `Git.prepare()` creates the checkout on the first run or fixes the remote URL.
2. `TargetResolver.resolve()` asks for the target commit. Nothing has been downloaded yet.
3. Up to date, a known failed commit or a dry run end the cycle here.
4. The lock is taken; everything after this point runs at most once per workspace at a time.
5. The target is fetched. The commit that was actually fetched is deployed, even if the branch moved in between.
6. Signature check and pre-update hook. A failure here ends with `failed` and the old version untouched.
7. Checkout, then `activate()`: install (if watched files changed), restart, health check, post-update hook.
8. On failure, `rollBack()` checks out the previous commit and runs `activate()` without the post-update hook.
9. `finish()` writes the state, sends notifications and returns the result. The lock is released in `finally`.

`update()` does not throw for a failed deployment; the result says what happened. It throws for problems before the
lock (network, Git, configuration), which the agent logs and retries at the next interval.

## Agent

`Agent` runs cycles one at a time. A trigger during a running cycle sets a flag, and the loop runs exactly one more
cycle afterwards, however many triggers came in. The next poll is scheduled after a cycle ends, so a slow deployment
never overlaps with a poll. `stop()` closes the webhook, clears the timer and waits for the running cycle.

## Commands and the shell

Two kinds of commands exist, and the type says which is which:

- **Argument lists** (`[program, ...args]`) run without a shell: every Git call and the built-in restarts. Values from
  the remote or the configuration are single arguments and cannot change the command.
- **Strings** run through the system shell: hooks, the install command, a custom restart and the health command.
  They are written by the operator and meant to use shell features.

On POSIX every command gets its own process group, so a time limit stops whatever it started; on Windows `taskkill /T`
stops the process tree.

## Quality gates

Every pull request runs lint (typescript-eslint strict type-checked, sonarjs), Prettier, `tsc --noEmit` with TypeScript
6 and 7, Vitest with coverage thresholds on Linux, Windows and macOS with Node 22 and 24, property-based tests, the
build, package checks, the installed package, the configuration entry on Deno and Bun, the container image with an
OSV scan, CodeQL, SonarQube Cloud, dependency review, OSV-Scanner on the lockfile and a secret scan. See
`.github/workflows/`.
