# Governance

Self-Updater is maintained by [VectoDE](https://github.com/VectoDE). This page says who decides what, how changes get
in, and how the project keeps going if the maintainer is gone.

## Roles

| Role        | Who                                                       | Responsibilities                                                                                                          |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Maintainer  | [@VectoDE](https://github.com/VectoDE)                    | Reviews and merges pull requests, triages issues, answers security reports, owns the release workflow and the npm package |
| Contributor | Anyone who opens an issue, a discussion or a pull request | Follows the [contributing guide](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md) and signs off commits (DCO)  |

A contributor with a record of good pull requests can be invited as a second maintainer. The invitation is a pull
request that adds them to this file and to [CODEOWNERS](CODEOWNERS).

## Decisions

- Bug fixes and small changes: a pull request that passes every required check. Pull requests from contributors
  need a maintainer's approval. While there is one maintainer, their own pull requests are merged once every check
  passes; when a second maintainer joins, the main ruleset will require an approval by someone other than the author
  for every pull request.
- New public API or breaking changes: discussed in an issue first, then decided by the maintainers. The reasoning is
  written down in the issue, so later readers can see why.
- Security reports follow the [security policy](SECURITY.md) and are handled privately until a fix is released.

## Releases

Every change merged into `main` is released by the [release workflow](workflows/release.yml), which publishes to
GitHub, npm, GitHub Packages and the GitHub Container Registry with signed provenance. Nobody publishes from a laptop, and version tags can only
be created by that workflow: a tag ruleset blocks everyone else, and the workflow only publishes tags on `main`.
See "Releases" in the [contributing guide](CONTRIBUTING.md#releases).

## Access to sensitive resources

| Resource                                                           | Who has access                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| GitHub repository settings, rulesets and secrets                   | [@VectoDE](https://github.com/VectoDE) (owner)                                                                     |
| Merging into `main`                                                | [@VectoDE](https://github.com/VectoDE), through pull requests only                                                 |
| Release deploy key (`RELEASE_DEPLOY_KEY`)                          | The release workflow on `main` only (environment `release`); no person holds the private key                       |
| Release signing key (`RELEASE_SIGNING_KEY`)                        | The release workflow on `main` only (environment `release`); registered as a signing key on the maintainer account |
| npm packages `@vectode/self-updater`, `self-updater` and the scope | [@VectoDE](https://github.com/VectoDE) on npmjs.com (2FA); releases are published through Trusted Publishing       |
| Security advisories                                                | [@VectoDE](https://github.com/VectoDE)                                                                             |
| SonarQube Cloud project and OpenSSF Best Practices entry           | [@VectoDE](https://github.com/VectoDE)                                                                             |

The list is updated in the same pull request that grants or removes access.

Before anyone gets more than read access (write or maintain rights, secrets, the npm package, security advisories),
the maintainers review their record: at least three merged pull requests of good quality, constructive behaviour in
issues and reviews, and two-factor authentication on GitHub and npm. The decision is recorded in that pull request.
Rights are given at the lowest level that does the job, and removed when no longer needed.

## Continuity

The project must keep working if a maintainer can no longer act:

- The code, issues, discussions, releases and the full history are public on GitHub, so anyone can fork and continue.
- Publishing needs no personal token: npm trusts the release workflow of this repository through OIDC.
- Repository, npm package and the `@vectode` scope belong to the maintainer account. Access for a second person is
  arranged by the maintainer and recorded here when it exists.
