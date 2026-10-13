# Roadmap

What the project plans for the next twelve months. Plans change; the current state is always in the
[issues](https://github.com/VectoDE/Self-Updater/issues) and the [changelog](../CHANGELOG.md). Ideas and objections
are welcome in [Discussions](https://github.com/VectoDE/Self-Updater/discussions).

## Ongoing

- Security and dependency updates as they come out, released within days. Supported versions are listed in the
  [security policy](../.github/SECURITY.md).
- Keep the package working on every active Node.js LTS line and on Linux, macOS and Windows.
- No runtime dependencies, so installing the package never pulls in third-party code.

## 4.x

Done in 4.1: several workspaces from one configuration file, blue-green deployments with a link switch, and a status
endpoint next to the webhook receiver.

- Microsoft Teams and email (SMTP) as notification targets, if issues ask for them.
- Run several workspaces in parallel during `update`, if one-after-the-other turns out too slow in practice.

## Not planned

- Building or deploying from a CI system to remote servers. Self-Updater runs on the server it updates; tools that push
  from CI already exist.
- Runtime dependencies or a plugin system that loads third-party code.
