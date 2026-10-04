# Contributing to Taimen Human Harness

Thank you for taking the time to contribute. Taimen is an organizational
runtime in which people, AI agents, workflows and services execute the work
of an organization; the platform is developed in the open under the
Apache License 2.0. This repository holds the **Human Harness** — a person's
work assistant built as a bundle of plugins for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
without forking it, plus the **launcher** that runs one isolated assistant
container per person. Upstream provides the agent loop, the Web Client and the
PWA shell; this repository provides the native connection to Control Plane and
IAM.

## Before you start

- Read the platform overview in the
  [guide](https://github.com/taimen-ai/taimen/tree/main/guide/docs/overview)
  (in Russian).
  Architecture decisions are recorded as ADRs (in Russian, with an English
  title line); English summaries are provided on request in the ADR's
  discussion.
- Check the open issues before starting a large change. For anything that
  changes the tool contract (`cp_*`), the `/api/harness/*` or launcher routes,
  the conversation surface contract (`surface/1`), the bundle patch or a
  platform API, open an issue first and propose an ADR.
- Changes to the agent loop, the Web Client or other upstream behaviour belong
  upstream in DeepSeek Harness, not here. The packages import `@deepseek-ai/*`
  for types; the runtime is resolved from the DSH installation and must not be
  duplicated.
- Read [SECURITY.md](SECURITY.md) before touching the launcher or the container
  image: the model in a person's container runs shell commands, and the launcher
  is the only thing between it and the Docker API.

## Contributor License Agreement

We require a signed Contributor License Agreement (CLA) for every
contribution, so that the project can be relicensed or defended without
tracking down every author. You sign once for all Taimen repositories.

- Individuals: [`cla/CLA-individual.md`](https://github.com/taimen-ai/taimen/blob/main/cla/CLA-individual.md)
- Companies contributing on behalf of employees: [`cla/CLA-entity.md`](https://github.com/taimen-ai/taimen/blob/main/cla/CLA-entity.md)

The CLA grants the project a copyright and patent licence to your
contribution; you keep your copyright.

## Development setup

Requirements: Node.js >= 22.19 and pnpm 11 (`corepack enable` picks the
version pinned in `package.json`). The repository is a pnpm workspace with the
packages under `packages/`; it has no sibling repositories — the core's
contract is the OpenAPI snapshot in `packages/control-plane/openapi/`.

```bash
pnpm install
pnpm typecheck      # tsc -b over every package, as in CI
pnpm test           # vitest, no network; includes the white-label guard
pnpm build          # tsc -b + tsdown: host libraries and the browser lib/client.js
```

`pnpm typecheck` and `pnpm test` need no running services. To try a change
against a live Control Plane, run the platform locally from the umbrella
repository (see its README) and put a Platform Access Token in
`~/.config/iam/credentials.json`. The bundle and the smoke script read:

| Variable | Meaning |
|---|---|
| `HARNESS_IAM_URL` | IAM issuer, default `http://localhost/iam` |
| `HARNESS_IAM_TENANT` | IAM tenant id (required; printed by the platform's bootstrap) |
| `HARNESS_IAM_PRINCIPAL` | IAM principal id, needed when the tenant has several tokens |
| `HARNESS_CONTROL_PLANE_URL` | Control Plane base URL, default `http://localhost` |
| `HARNESS_CONFIRM_MUTATIONS` | `false` disables the mutation confirmation; debugging only |

```bash
pnpm smoke          # PAT exchange -> whoami -> "Important", writes nothing
pnpm profile:init   # dsh profile `human-harness` = web template + link: to the packages
pnpm dev            # build and start the DSH Web UI with that profile
```

`DSH_HOME` selects the dsh home directory (profiles, `settings.yaml`,
credentials); for an isolated check use your own, for example the git-ignored
`.dsh-home/` inside the repository — never commit it. The upstream DSH version
is pinned in `package.json`; when bumping it, check the contracts listed in the
README first.

The container image (`Dockerfile`) installs the proprietary Claude Agent SDK;
see [THIRD_PARTY.md](THIRD_PARTY.md) before building or distributing it.

## Pull requests

- One logical change per pull request; keep the history linear (rebase, no
  merge commits).
- `pnpm typecheck` and `pnpm test` must pass; behaviour changes come with
  vitest tests.
- A dependency change regenerates `THIRD_PARTY.md` (`pnpm third-party`).
- Commit messages explain *why*, not *what*; reference the ADR or issue.
- Public contract changes (tools `cp_*`, routes, the bundle patch, environment
  variables) update the README and, when they break compatibility, are called
  out in the pull request.
- Do not include secrets, customer data or internal hostnames (in particular
  nothing from a `DSH_HOME` or `~/.config/iam`).

## Reporting bugs and security issues

Bugs: open an issue in this repository with the version, the DSH version,
steps to reproduce and logs. Security issues: see [SECURITY.md](SECURITY.md)
and do not open a public issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
