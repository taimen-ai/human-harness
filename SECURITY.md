# Security Policy

## Supported versions

Human Harness is pre-1.0 and follows the Taimen platform releases. Security
fixes are made on the `main` branch and included in the next platform
release; there are no long-term support branches yet.

| Version | Supported |
|---|---|
| latest `main` / latest `v0.x` tag | yes |
| older tags | no |

The upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) version is pinned in `package.json`; a fix that requires an upstream
change is delivered by bumping that pin.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub's private vulnerability reporting: open the
**Security** tab of this repository and choose **Report a vulnerability**.
If that option is not available to you, open an issue that only says
"security: please contact me" without any details, and a maintainer will reach
out through a private channel. Include in the private report:

- the version (tag or commit) and the DSH version from `package.json`,
- steps to reproduce or a proof of concept,
- the impact you expect (what an attacker gains),
- whether the issue is already public.

You will get an acknowledgement within 5 business days and a status update at
least every 14 days until the issue is resolved. We ask for coordinated
disclosure: please give us up to 90 days to ship a fix before publishing details.
Credit is given in the release notes unless you prefer to stay anonymous.

## Threat model

This section states what the harness defends against and what it does not.
Each statement refers to code in this repository; deployment advice is marked
as such.

### Components and trust

- **The launcher** (`packages/launcher`) is the only way into a person's
  assistant. It signs people in (Keycloak Authorization Code + PKCE, then IAM
  `federation:exchange`), keeps a signed session cookie (12 h), proxies HTTP and
  WebSocket traffic into that person's container, and creates, starts, stops and
  deletes the containers through the Docker Engine API.
- **A person's container** runs the DSH host with the harness plugins from a
  pinned image, one container per IAM principal, user uid 10001 (set by the
  image). The model running there has a shell. **The container is untrusted.**
- **Control Plane, IAM and the notification service** are separate services;
  the container talks to them with the person's own credentials, and Control
  Plane decides what the person may do.

### The Docker API: access to the proxy is root on the host

The launcher reaches Docker through
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) (or a
local socket in development). The proxy filters API sections, not request
bodies: whoever can send `POST /containers/create` to it can start a privileged
container with the host filesystem mounted, i.e. **reaching the proxy is
equivalent to root on the host**.

What the launcher does about it (`packages/launcher/src/docker.ts`):

- it builds every `POST /containers/create` body itself and refuses it before
  sending (`checkCreate`) unless the image equals the pinned `LAUNCHER_IMAGE`,
  the principal id is a UUID, the container is named `harness-<principal>`, the
  volume `harness-data-<principal>`, the secrets directory is an absolute clean
  path that is exactly `<secrets base>/<principal>` (see below), and the network
  equals `LAUNCHER_NETWORK` exactly — an allowlist of one, not a denylist, so a
  compose network such as `<stack>_default` is refused; `host`, `bridge`,
  `none`, `default` and `container:<id>` are refused even if `LAUNCHER_NETWORK`
  names them. That refusal compares **names**: Docker also resolves a network
  by its ID, and the ID of `host` or `bridge` is not one of those names, so
  anything that looks like a network ID (12–64 hex characters) is refused too,
  at startup and in `checkCreate` — `LAUNCHER_NETWORK` must be a name;
- the finished body is checked again before sending: `HostConfig.NetworkMode`
  equals `LAUNCHER_NETWORK`, `NetworkingConfig.EndpointsConfig` names no other
  network, `Privileged` is `false`, and the limits are checked as Docker will
  read them: `Memory` ≥ 6 MB with `MemorySwap` equal to `Memory` (no swap
  beyond the memory limit), `NanoCpus` ≥ 10,000,000 (0.01 CPU — a smaller
  `LAUNCHER_HARNESS_CPUS` would round to 0, which Docker reads as "no limit"),
  `PidsLimit` an integer ≥ 1. The launcher also refuses to start with a
  forbidden `LAUNCHER_NETWORK` or limits below these bounds, and with limits
  above a fixed ceiling — it does not know the host's resources, so the
  ceiling is 64 CPU, 64 GB of memory and 65,536 processes;
- the body always carries `Privileged: false`, `CapDrop: ["ALL"]`,
  `SecurityOpt: ["no-new-privileges"]`, `Memory`, `MemorySwap`, `NanoCpus` and
  `PidsLimit` (defaults: 1536 MB, 1 CPU, 512 processes —
  `LAUNCHER_HARNESS_MEMORY_MB`, `LAUNCHER_HARNESS_CPUS`, `LAUNCHER_HARNESS_PIDS`)
  and the label `harness.spec=3` (spec 2 containers were created without
  `MemorySwap`); the secrets directory is mounted read-only;
- start, stop and remove first inspect the container and refuse unless it has
  the label `harness.managed=true` and the pinned image; a volume is removed only
  with that label; an already existing volume `harness-data-<principal>` is
  attached only if it carries `harness.managed=true` and
  `harness.principal=<principal>`;
- a stopped container created by an older spec or attached to another network
  is recreated on its next wake (the volume is kept).

Deployment requirements (not enforced by the code):

- the proxy must be reachable **only** by the launcher: put both on an internal
  network of their own (`internal: true`, nothing else attached) and never
  publish the proxy port;
- allow only the API sections the launcher uses (containers, volumes, POST) and
  keep exec, images, networks, build and the rest closed;
- `LAUNCHER_IMAGE` is compared as a string; pin it by digest if other parties
  can tag images on the host;
- `LAUNCHER_NETWORK` is the only network the launcher will attach, so it must
  be a separate network for people's containers (below), not the stack's
  default network: the allowlist only enforces what you configure.

The secrets base. `LAUNCHER_SECRETS_BASE` is the host directory that holds the
people's secrets directories. When it is not set, the launcher derives it from
`LAUNCHER_PEOPLE_FILE` as the common parent of every `secretsDir`; if the
entries have different parents or the parent is `/`, it refuses to start and
asks for the variable. Either way every entry must be `<base>/<principalId>`,
otherwise the launcher refuses to start. With no variable and no people there
is no base and no secrets directory is ever mounted. Set the variable
explicitly in production, so that an edited people file cannot move the base.

The launcher checks the base and the directory as **strings**; it does not
look at the host filesystem (it reaches the host only through the Docker API).
So the base — `LAUNCHER_SECRETS_BASE` or the one derived from the people
file — and **every parent directory up to `/`** must be writable only by
root. If anyone else can write the base or a parent, they can replace
`<base>/<principal>` or a parent with a symlink, and Docker will follow it on
the host when it mounts the directory: one person's container then gets
another person's secrets or any other host path. Do not put the base under a
home directory, a shared volume or anything a container can write.

### Networks

`LAUNCHER_NETWORK` is the network people's containers are attached to. It
should hold only what the assistant needs: Control Plane, the notification
service, the edge proxy (IAM is reached by its public address) and the launcher
itself — no proxy, databases, object storage, secret stores, IdP or memory
service. People's containers need outbound internet access (the Claude API, the
code forge), so this network is usually not internal; egress is not filtered by
the harness.

All people's containers share that network, so one container can open a TCP
connection to another one's DSH port. What stops it is not the network but
authentication: every DSH `/api` request needs the DSH session cookie, the
entry `/_harness/enter` needs the `X-Harness-Launcher` header (HMAC of
`ts.principal` with that container's own secret), and `/internal/harness/*`
needs that secret as a bearer token.

### What the model in the container can do

The assistant runs shell commands as uid 10001 inside the container. Shell
commands run under DSH's own sandbox and approval policy — upstream
configuration that this repository does not pin and **does not rely on**.
Assume the model can:

- read every file mounted into the container, including the person's secrets
  directory (below), and its environment, including `HARNESS_LAUNCHER_SECRET`
  (it only authenticates calls to this same container);
- make network requests to anything reachable from `LAUNCHER_NETWORK` and the
  internet;
- use up the container's CPU, memory and process limits and fill its volume
  (there is no disk quota on the volume).

Guardrails that are **not** security boundaries: the git `pre-push` hook (only
`task/*` branches), the git credential helper that offers the forge token only
to `github.com`, and the persona instructions. The model can bypass all of
them.

### Secrets of a person

The launcher mounts `<secrets base>/<principalId>` read-only at
`LAUNCHER_SECRETS_TARGET` (`/run/secrets/harness`). It may contain:

- `credentials.json` — the person's IAM Platform Access Token. Its ceiling
  should exclude admin scopes; Control Plane enforces the person's own
  permissions on every call;
- `claude-oauth-token` — the person's Claude subscription token, read by the
  `claude-code` model provider on every turn and passed only to the Claude Code
  process;
- `forge-token` — the person's code forge token, used by the git credential
  helper.

The entrypoint passes paths, not values, to the DSH process and unsets
`CLAUDE_CODE_OAUTH_TOKEN` and `IAM_PLATFORM_ACCESS_TOKEN`. This keeps tokens out
of logs and process listings, but the files themselves are readable by the
model's shell: **a successful prompt injection can exfiltrate all three.** Give
these tokens the narrowest scope and lifetime you can, and rotate them when a
container may have been compromised.

### Prompt injection is the main attack vector

Text the model reads is attacker-controllable: Control Plane task titles,
descriptions, comments and artifacts, documents and files, event payloads,
messages arriving from a channel (`POST /_launcher/internal/principals/{id}/inbound`
accepts any IAM token with audience `human-harness` and scope
`harness:inbound` — in a platform deployment, the notification service), the
console's `screenContext`, and anything fetched from the network. Defences in
the code:

- the `cp_*` tools that change Control Plane state — tasks, comments,
  approvals, delegation and review, claims, artifacts, completion, skills,
  memory — ask the person through the DSH user-approval seam and fail closed
  without it (`HARNESS_CONFIRM_MUTATIONS`, on by default). Exceptions: a progress
  checkpoint on work the person has already taken (`cp_checkpoint`) and the
  local workspace selection;
- the persona tells the assistant to propose new work as a link that the person
  signs in the console instead of creating it (`cp_propose_task`); this is an
  instruction to the model, and `cp_create_task` / `cp_delegate` still exist
  behind the confirmation above;
- the `screen-context` section is bounded and its free text is JSON-escaped, so
  text inside it cannot close the section; it is presented to the model as data,
  not as the person's words;
- Control Plane, not the harness, decides permissions; a `403` is reported, not
  worked around.

None of this stops a model that follows injected instructions from using the
shell, the network or the secrets described above. The blast radius is one
person's container, credentials and conversation.

### The launcher itself

- The launcher holds the cookie signing key and, for the sweep of disabled
  principals, the **IAM bootstrap token** (`LAUNCHER_IAM_BOOTSTRAP_TOKEN_FILE`), IAM's
  administrative credential. Treat a launcher compromise as an IAM and
  host compromise. Without the bootstrap token the sweep is off.
- The container is chosen only by the signed launcher cookie; the launcher
  cookies are stripped before proxying, and an incoming `X-Harness-Launcher`
  header is replaced by the launcher's own. Deployment: the edge proxy should
  also drop `X-Harness-Launcher` and `X-Harness-Principal` from outside requests.
- Surface routes (`/_launcher/internal/principals/{id}/surface/*`) require an
  IAM access token with audience `human-harness`, scope `harness:use`,
  `principal_type=human` and `sub` equal to `{id}`.
- A principal that IAM reports as `disabled` or gone has its container and
  volume removed within the sweep interval (one minute); `paused` stops it.

## Scope

In scope: the code of this repository — the launcher
(`@human-harness/launcher`), the DSH plugins (`@human-harness/dsh-identity`,
`@human-harness/dsh-control-plane`, `@human-harness/dsh-llm-claude-code`,
`@human-harness/dsh-client-ui-human-harness`), the bundle
(`@human-harness/dsh-human-harness` with `cordis.patch.yml`), the container
image definitions (`Dockerfile`, `packages/launcher/Dockerfile`, `docker/`) and
the `scripts/`. Typical problems worth reporting: a way around `checkCreate` or
the label and image checks; a person reaching another person's container or
conversation; a Platform Access Token or access token reaching the browser or a
log; a mutation that bypasses the user-approval seam; a `/api/harness/*` route
reachable without the DSH session; a tool that widens the principal's
permissions beyond what Control Plane grants.

Out of scope:

- **Upstream DeepSeek Harness** (the agent loop, its sandbox and approval
  policy, the Web Client, the PWA shell and the `@deepseek-ai/*` packages):
  report to the [upstream project](https://github.com/deepseek-ai/deepseek-harness).
  Tell us if a fix requires a coordinated pin bump here.
- **Claude Code and the Claude Agent SDK**: report to Anthropic.
- The Taimen platform services this harness talks to (`control-plane`,
  `iam-service`, `notification-service`, ...): report against their own
  repositories or the umbrella repository's security policy.
- Behaviour that this document already lists as possible for the model in a
  person's container (reading its own secrets, using its own network access),
  unless it crosses into another person's container, the host or the Docker API.
- Other third-party npm dependencies (report upstream), demo data, and
  deployments run by third parties.

## Hardening notes for operators

- Follow the network layout above: proxy and launcher alone on an internal
  network; people's containers on a separate network with only what the
  assistant needs.
- Issue each person a Platform Access Token without admin scopes and with a
  bounded lifetime; scope the forge token to the repositories the person works
  in.
- Keep `HARNESS_CONFIRM_MUTATIONS` at its default: every mutation goes through
  the DSH user-approval seam and fails closed without it. `false` is for
  debugging only.
- Keep the container limits (`LAUNCHER_HARNESS_MEMORY_MB`,
  `LAUNCHER_HARNESS_CPUS`, `LAUNCHER_HARNESS_PIDS`) and watch the volumes'
  disk usage.
- Set `LAUNCHER_SECRETS_BASE` explicitly instead of relying on the value
  derived from the people file.
- Running the DSH host outside a container (development), keep it on
  `127.0.0.1`; `DSH_HOME` holds profiles, `settings.yaml`, `.credentials.yaml`,
  model-provider keys and sessions — never commit or share it.
