# Human Harness

*English. Russian version: [README.ru.md](README.ru.md)*

An employee's personal work assistant — the platform's Human Work Surface (HWS, ADR-0024).
It is assembled as a bundle of plugins for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) without a fork:
upstream provides the agent loop, the Web Client and the PWA shell; this repository provides
the native connection to the platform services. The decisions are ADR-0033 and ADR-0051 of
the platform umbrella repository.

The harness is white-label: code names carry no product name. The person sees the company
name from the Control Plane tenant and the application name from the installation
(`HARNESS_APP_NAME`, default "Human Harness"); the guard is
`packages/control-plane/tests/white-label.test.ts`.

```text
human ──► DSH Web UI (PWA) ──► DSH host (Node, on the person's machine)
                                ├─ @human-harness/dsh-identity        IAM PAT → access token (audience control-plane)
                                ├─ @human-harness/dsh-control-plane   harness Session, cp_* tools, /api/harness/*
                                ├─ @human-harness/dsh-client-ui-…     one window: conversation and "Important" (browser)
                                └─ @human-harness/dsh-human-harness   bundle: cordis.patch.yml + assistant persona
                                               │
                                               ▼  HTTPS, bearer IAM
                                  Control Plane (tasks, approvals, events, Context Gateway → memory)
```

## Principles

- **Native, not through an MCP bridge.** The model's tools and the panels talk to Control Plane
  directly through a typed client; identity is a PAT exchange in IAM (the `platform-auth` contract).
- **Memory — only through Control Plane, by PAT** (`POST /api/v1/context`,
  `POST /api/v1/observations`). The harness has no direct client to memory-service.
- **Nothing stays only in the conversation.** Mutations are typed `Task`,
  `Approval`, comments, Observation; each one passes human confirmation
  through the DSH `user-approval` seam and refuses without it (fail closed).
- **"Important" is computed by the core** (CP-ADR-0071): `GET /api/v1/me/attention` — deterministic rules with a reason, rule and actions. The harness recomputes nothing; against a core older than CP-ADR-0071 "Important" is empty with an `endpoint_missing` note and the window keeps working.
- **A proactive assistant in one conversation** (TAI-ADR-0051 §6). The host consumes the core's
  event journal by the CP-ADR-0069 contract: `GET /api/v1/events` from a cursor stored in
  `$DSH_HOME/harness/event-cursor.json`, the `WS /api/v1/events/ws` socket only wakes the reader,
  a 30 s safety poll, dedup by `event.id`. Significance is data — `attention-rules.json` (see
  below). A significant fresh event becomes an assistant turn in the person's single conversation
  (source `platform-event`); a burst is grouped for 20 s into one turn; `digest` rules and
  everything that happened while the container slept go into one "while you were away" summary
  when the person opens the window again. Reminders ("remind me on Friday") are `dsh-schedule` in
  the same conversation.
- **Outside the upstream tree.** The packages import only types from `@deepseek-ai/*`; the runtime
  (`Service`, `defineTool`) is not duplicated — a single copy of cordis lives in the dsh profile.

## Packages

| Package | Half | What it does |
|---|---|---|
| `@human-harness/dsh-identity` | host | `ctx.harnessIdentity`: PAT from `~/.config/iam/credentials.json` (key `issuer\|tenant[\|principal]`) or `IAM_PLATFORM_ACCESS_TOKEN` + `IAM_CREDENTIAL_MODE=environment`; `platform-access-tokens:exchange` exchange, cached up to the threshold |
| `@human-harness/dsh-llm-claude-code` | host | DSH model provider `claude-code`: the assistant turn runs in Claude Code (Claude Agent SDK) on the owner's subscription, resuming the linked Claude session; the DSH agent's tools reach Claude through an in-process MCP bridge into `ctx.tools.execute` (DSH policies, approvals, sandbox); Claude's built-in tools are disabled |
| `@human-harness/dsh-control-plane` | host | `ctx.controlPlane`: Session (`clientName human-harness`, `harness.type deepseek-harness`) with heartbeat; "Important" (`me/attention`); tools `cp_whoami/attention/agents/task_types/task_type_executors/propose_task/delegate/run_progress/review/take_task/active_work/checkpoint/register_artifact/complete_task/release_task/invoke_skill/get_task/find_tasks/create_task/update_task/comment_task/decide_approval/recall/remember`; routes `/api/harness/{whoami,conversation,attention,changes,attention.discuss,attention.feedback,wake,workspaces,approvals.decide,…}`; the event consumer and significance rules (proactivity) |
| `@human-harness/dsh-client-ui-human-harness` | web + host | a frame built to the layout instead of the DSH AppFrame (the `ui-layout` entry is disabled in the bundle; the `ctx.layout` service, the `panelInfo` hook and the theme presenter live here), the `harness` theme on alias tokens, one window: the DSH conversation in the centre and "Important" on the right (tabs "Assistant | Important" on narrow screens), no screens and no navigation hotkeys; the host half serves the IBM Plex fonts at `/api/harness/fonts/*` and the PWA manifest (name from `HARNESS_APP_NAME`). Data comes from `/api/harness/*` under the DSH session cookie; the PAT never reaches the browser |
| `@human-harness/launcher` | process | the dispatcher of personal harnesses (TAI-ADR-0051 §2): person sign-in (OIDC PKCE → IAM `federation:exchange`), HTTP/WebSocket proxy into that person's container, container lifecycle through docker-socket-proxy, deletion of conversations of disabled principals, channel inbound. No dependencies beyond Node built-ins |
| `@human-harness/dsh-human-harness` | bundle | `cordis.patch.yml`: plugin insertion, assistant persona instead of the web-app coding persona |

## Significance rules (`attention-rules.json`)

The defaults ship with `@human-harness/dsh-control-plane` (`attention-rules.json`, schema
`attention-rules.schema.json`); an installation replaces them with its own file
(`HARNESS_ATTENTION_RULES`). Rules are checked in file order, the first match wins.

| Field | Meaning |
|---|---|
| `key`, `version` | Rule identity `key@version`; it is shown with every proactive item |
| `on` | Exact core event types; together they form the `types` filter of the subscription |
| `concerns` | Relation to the person: `approval-mine` (assigned to them or their role), `task-assignee`, `task-creator` (a delegation), `task-involves` (assignee, author or owner), `any` |
| `when` | Conditions on event fields by dotted path; `"$me"` is the person's principal |
| `skipOwnActions` | Skip the person's own actions (default `true`) |
| `significance` | `now` — the assistant comes on its own; `digest` — only in the summary |
| `message`, `action` | Templates with `{{path}}` (event fields, `payload.*`, `task.publicId`, `task.title`): what happened and which action to offer |

The window gets a long-poll signal (`/api/harness/changes`) and re-reads "Important" as soon as
an event concerns the person. `/internal/harness/status` tells the launcher whether a turn is
running and when the next reminder is due.

Known limitation: the DSH chat labels a message with an unknown source as "Execution requested"
(a closed switch in `dsh-client-ui-chat`); the expanded card shows the event text.

## Launcher

One container per person, created by the launcher from a pinned image; the launcher is the only
way in. Paths are relative to its mount (`LAUNCHER_MOUNT`, derived from `LAUNCHER_PUBLIC_URL`):

| Path | What |
|---|---|
| `/_launcher/login`, `/_launcher/callback`, `/_launcher/logout` | Person sign-in: Keycloak Authorization Code + PKCE, then IAM `federation:exchange` → IAM principal; signed launcher cookie (12 h) |
| `POST /_launcher/internal/principals/{id}/inbound` | Channel text into the person's conversation; IAM access token, audience `human-harness`, scope `harness:inbound` |
| `/_launcher/internal/principals/{id}/surface/{message,stream,history,approval}` | Conversation surface (console, contract `surface/1`) → container `/internal/harness/surface/*`; person's IAM access token, audience `human-harness`, scope `harness:use`, `sub` = `{id}`. `message`/`approval`/`history` wake the container, only `message`/`approval` reset the idle timer; `stream` never wakes it: a sleeping container gives `sleeping` and the connection stays open until someone else wakes it (`waking`, then the container's own events). Limits: body ≤64 KB, ≤8 streams per person, cursor ≤200 chars, 30 s for the container's reply |
| `/_launcher/health` | Liveness |
| anything else | Proxied (HTTP and WebSocket) into the container of the principal from the cookie |

Isolation: the container is chosen only by the signed cookie, the launcher cookie never reaches
the container, and every proxied request carries `X-Harness-Launcher: v1.<ts>.<hmac>` — HMAC of
`ts.principal` with the per-container secret (`HARNESS_LAUNCHER_SECRET`). Inside the container
the harness plugin serves:

| Container path | What |
|---|---|
| `/_harness/health` | Readiness (cold start is measured until it answers 200). Behind the launcher: 503 until the conversation is bound to the DSH session services; the launcher calls it before every proxied request, so it stays cheap |
| `/_harness/enter` | Valid launcher header for this container's principal → redirect to the DSH `authenticatedUrl()` (the standard DSH cookie); otherwise 401 |
| `/internal/harness/status` | `{busy, nextWakeAt}` — bearer = container secret |
| `POST /internal/harness/inbound` | `{text, channel}` → a `channel` message in the single conversation — bearer = container secret |
| `/internal/harness/surface/{message,stream,history,approval}` | Conversation surface API (contract `surface/1`): the console writes into the same conversation, reads it as SSE and history, answers approvals (first answer across window, Telegram and console wins); the message's `screenContext` enters that turn only, as a `screen-context` section, and never shows up in the person's history — bearer = container secret |

The `screen-context` section (plugin `packages/control-plane/src/screen-context.ts`):

- it is bounded on both sides: `<screen-context>…</screen-context>`, free text (label,
  projection) is JSON with `<` and `>` encoded as `\u003c`/`\u003e`, so a closing marker
  written into a label or a run result by someone else cannot leave the section; the
  bounds are part of the message itself, identical for every model driver;
- the `claude-code` driver labels it as screen context (the literal Russian label
  `Контекст экрана`) in a cold-start transcript, never as the person's words;
- known behaviour: its source form is `snapshot` ("a later snapshot supersedes an earlier
  one"), and a turn without screen context writes no new snapshot, so the previous section
  is not cleared from the model's history. The persona rule on the console (the paragraph
  `Консоль.` of the persona in `cordis.patch.yml`) covers this: the section belongs to its own turn only, and a later reply without it takes the object from
  the conversation or asks;
- both listeners (`agent/pre-step`, `agent/inbox/discarded`) are registered `global`; the
  section's position among other step snapshots (e.g. `dsh-time-context`) depends on plugin
  load order and carries no meaning.

The DSH web client uses relative paths (`<base href="./">`), so the harness works under a mount
prefix; the harness client does the same (`api/harness/*`).

Lifecycle: created and started on the first request (volume `harness-data-<principal>` at
`/data`, the person's secrets directory read-only at `LAUNCHER_SECRETS_TARGET`, label
`harness.managed=true`); stopped after `LAUNCHER_IDLE_MINUTES` (30) without requests and without a
running turn, remembering the next reminder; started again at that time. Every minute the sweep
asks IAM for the status of every principal with a container or volume: `disabled` or gone from the
tenant — container and volume are removed (`conversation.deleted` in the journal); `paused` —
stopped. Every Docker mutation first checks the `harness.managed` label and the pinned image.
The journal is JSON lines on stdout.

Isolation. The model inside a person's container has a shell, so the container is treated as
untrusted. docker-socket-proxy does not inspect request bodies, so the launcher builds every
`POST /containers/create` itself and refuses (`checkCreate`) anything but the pinned image, the
container and volume named after the principal, that principal's own secrets directory (exactly
`<LAUNCHER_SECRETS_BASE>/<principalId>`), exactly the network `LAUNCHER_NETWORK` (an allowlist of
one: `NetworkMode` must equal it and `NetworkingConfig.EndpointsConfig` may name no other network;
`host`, `bridge`, `none`, `default` and `container:*` are refused even if configured, and so is
anything that looks like a network ID — 12–64 hex characters — since that refusal compares names), no
privileges (`Privileged: false`, `CapDrop: ALL`, `no-new-privileges`; uid 10001 comes from the
image) and the memory, CPU and process limits as Docker will see them: at least 6 MB of memory with
`MemorySwap` equal to `Memory` (no swap beyond the limit), at least 0.01 CPU (`NanoCpus` ≥ 10⁷, so
a tiny `LAUNCHER_HARNESS_CPUS` never rounds to 0 = unlimited) and at least 1 process. The same
bounds and the network are checked at startup, together with a fixed ceiling (at most 64 CPU,
64 GB of memory, 65,536 processes). The secrets base and all its parents must be writable only by
root (see SECURITY.md). An existing volume `harness-data-<principal>` is
reused only if it carries the labels `harness.managed=true` and `harness.principal=<principal>`.
The proxy must be reachable only by the launcher: put it on an
internal network shared with the launcher alone, and set `LAUNCHER_NETWORK` to a separate network
for people's containers that holds only what the assistant needs (Control Plane, notifications,
the edge proxy for IAM, the launcher). A stopped container created by an older spec (label
`harness.spec`, currently `3`; spec 2 containers lack `MemorySwap`) or attached to another network
is recreated on its next wake; the volume stays.

| Variable | Meaning |
|---|---|
| `LAUNCHER_PUBLIC_URL` | External URL, e.g. `https://cp.example.com/harness` |
| `LAUNCHER_MOUNT` | Path prefix (default — the path of `LAUNCHER_PUBLIC_URL`) |
| `LAUNCHER_PORT` | Listen port (8080) |
| `LAUNCHER_COOKIE_SECRET_FILE` | Key for the launcher cookies |
| `LAUNCHER_OIDC_ISSUER`, `LAUNCHER_OIDC_CLIENT_ID`, `LAUNCHER_OIDC_SCOPES` | Keycloak realm, public PKCE client (`human-harness`), scopes (`openid`) |
| `LAUNCHER_IAM_URL`, `LAUNCHER_IAM_ISSUER`, `LAUNCHER_IAM_TENANT` | IAM API (internal), token issuer (public), tenant |
| `LAUNCHER_IAM_IDENTITY_PROVIDER`, `LAUNCHER_IAM_AUDIENCE`, `LAUNCHER_IAM_SCOPES` | Federation at sign-in: provider key (`keycloak`), audience (`human-harness`), scopes (`harness:use`) |
| `LAUNCHER_IAM_BOOTSTRAP_TOKEN_FILE` | IAM bootstrap token — the only IAM path to principal status; without it the sweep is off |
| `LAUNCHER_DOCKER_URL` | `http://harness-docker-proxy:2375` or `unix:///var/run/docker.sock` |
| `LAUNCHER_IMAGE`, `LAUNCHER_NETWORK`, `LAUNCHER_HARNESS_PORT`, `LAUNCHER_HARNESS_MEMORY_MB` | Pinned image, Docker network of people's containers (full name, without the proxy and databases), DSH port (3080), memory limit (1536) |
| `LAUNCHER_HARNESS_CPUS`, `LAUNCHER_HARNESS_PIDS` | CPU limit in cores (1, from 0.01 to 64) and process limit (512, from 1 to 65536) of a person's container; memory is from 6 MB to 64 GB |
| `LAUNCHER_HARNESS_ENV` | JSON object of environment for every container (`HARNESS_CONTROL_PLANE_URL`, `HARNESS_IAM_URL`, …) |
| `LAUNCHER_PEOPLE_FILE` | JSON `{"<iamPrincipalId>": {"secretsDir": "<base>/<iamPrincipalId>"}}` — who has a workplace |
| `LAUNCHER_SECRETS_BASE` | Host directory that holds the people's secrets directories; each `secretsDir` must be exactly `<base>/<principalId>`. If unset, the base is derived from `LAUNCHER_PEOPLE_FILE` as the common parent of all `secretsDir`; entries with different parents, a parent of `/`, or a directory not named after its principal stop the launcher at startup. With no people and no variable nothing is mounted. Set it explicitly in production |
| `LAUNCHER_SECRETS_TARGET` | Where the secrets directory is mounted (`/run/secrets/harness`) |
| `LAUNCHER_IDLE_MINUTES`, `LAUNCHER_START_TIMEOUT_SECONDS` | Sleep after idle (30), cold-start budget (30) |
| `LAUNCHER_STATE_FILE` | Container secrets, last request, wake time |
| `LAUNCHER_DEV_UPSTREAM`, `LAUNCHER_DEV_SECRET_FILE` | Development: every principal goes to one running harness, no Docker |

## Documents in the window

Documents open in the standard DSH document preview (`dsh-client-ui-sidebar-documentpreview`) in
the window's right column, instead of "Important"; on a narrow screen — over the conversation. The
frame declares the DSH `rightbar` slot and shows it only for a document tab (the "Start" page, files
and terminal of the DSH right sidebar are not shown; a tab DSH restores on load does not cover the
conversation). DSH previews Markdown, code, images, PDF and HTML; the harness adds DOCX
(`docx-preview`, rendered inside a script-less iframe, fitted to the pane width), XLSX
(`read-excel-file`, values as text, formulas not evaluated) and CSV/TSV. Links to files in the
assistant's answers open the preview. A core artifact (`GET /artifacts/{id}/content`) is fetched by the
`cp_fetch_artifact` tool into `.artifacts/<id>/` of the conversation's workspace, and the assistant
links it; active content (HTML, SVG, XML) is saved as `.txt` and shown as text. The other way round, a
document the person made with the assistant (Word, Excel, PowerPoint via `python-docx`/`openpyxl`/
`python-pptx` in the image) is submitted as the result of their work: `cp_register_artifact` with
`file` reads it only from inside the conversation's workspace (symlinks resolved), uploads it with
`PUT /artifact-contents` and creates the artifact with the returned `contentRef` (CP-ADR-0072). The browser bundle must
not require Node built-ins — `tests/bundle.test.ts` guards it (jszip and fflate are aliased to their
browser builds in `packages/ui-human-harness/tsdown.config.ts`).

## The channel as the same conversation

Telegram is a second surface of the single conversation (TAI-ADR-0051 §7). The notification
service passes a linked person's text to the launcher, and it arrives as a turn with the source
`channel`. The assistant's answer to that turn goes back as a notification to the person
(`POST /api/v1/notifications` of the notification service with the person's own token, audience
`notification-service`, scope `notifications:send`; `HARNESS_NOTIFY_URL`); a long answer is cut
with a link to the window (`HARNESS_PUBLIC_URL`). A tool confirmation asked during such a turn is
sent as buttons (`data.kind = "harness_approval"`); the press comes back through the same inbound
(`{approval: {id, decision}}`) and answers `ctx.approval.request`. The window may answer too — the
first answer wins; if the channel is unavailable, only the window decides.

The assistant's relative links to console screens (`/console/…`) are made absolute in a channel
answer, from the window address (`HARNESS_WINDOW_URL`) — so a work proposal link, for example,
opens the form in the console from the messenger. If the answer exceeds the channel limit, the
`result` and `basis` fields of proposal links are squeezed (500, 200, 50 characters, then dropped)
so the link is not cut in the middle.

## Proposing work by link

The assistant does not create work itself (a Human Control decision: work is created by the
person's signature). On "assign…", "create work…" it picks a type allowed in the workspace
(`cp_task_types` → `GET /api/v1/task-types?workspaceId=`) and an executor of that type
(`cp_task_type_executors` → `GET /api/v1/task-types/{id}/executors?workspaceId=`) and answers with a
`cp_propose_task` link: `/console/work/new?title=…&type=…&exec=…&owner=…&due=…&ws=…&result=…&basis=…`
(the console contract — the work screen, "In words: a proposal by link"; the link is built by
`consoleUrl.proposal`: values are URL-encoded including `!'()*.` — otherwise a parenthesis would break the link in
markdown and in the console parser — empty ones dropped, `title` ≤ 500, `result` and
`basis` ≤ 2000). The console renders it as a card "Work will be created — your signature is
needed", and the "Create work" button creates it. No executor found — the link has no `exec`.
Task TASK-001349.

## Container image

`Dockerfile` builds the personal harness image: the DSH profile `human-harness` with this
repository's packages, Claude Code (the Claude Agent SDK's Linux build from the lockfile), git, and
`python-docx`/`openpyxl`/`python-pptx`; user uid 10001. `packages/launcher/Dockerfile` builds the
launcher (one file, Node built-ins only). The container entrypoint (`docker/entrypoint.sh`):

- keeps the person's state in the `/data` volume (`DSH_HOME=/data/dsh`, `HOME=/data/home`); the
  profile from the image is linked in;
- reads secrets only as files from `HARNESS_SECRETS_DIR` (mounted read-only by the launcher):
  `credentials.json` (IAM PAT), `claude-oauth-token` (read by the model provider on every turn and
  passed only to the Claude Code process), `forge-token` (the git credential helper, github.com
  only); none of them is in the DSH process environment, but the model's shell can read the files
  (see [SECURITY.md](SECURITY.md));
- global git from `docker/gitconfig`: the credential helper and the `pre-push` hook (only
  `task/*` branches are published);
- DSH listens on all interfaces only inside the image (`HARNESS_CONTAINER=1` switches the
  `webserver` row of the bundle): the container publishes no ports, every `/api` request needs the
  DSH cookie and entry needs the launcher HMAC; `HARNESS_TRUSTED_HOSTS` — the public host.

Measured locally (Docker Desktop, arm64): cold start of a new person — volume, container, start,
ready — 4.4 s; wake after sleep — 2.1 s (budget — 30 s).

The image contains the Claude Agent SDK, which is proprietary software of Anthropic: build and
distribute the image on Anthropic's terms. The project does not publish ready-made images; see
[THIRD_PARTY.md](THIRD_PARTY.md).

## Running locally

You need Node ≥ 22.19, pnpm 11 (corepack), an IAM PAT in `~/.config/iam/credentials.json`
and a model provider in DSH (Settings → Models; DSH stores the key itself).

```bash
pnpm install
pnpm build          # tsc -b + tsdown (host lib + browser lib/client.js)
pnpm test           # vitest: projections, client, identity
pnpm smoke          # live Control Plane: PAT exchange → whoami → "Important" (me/attention)
pnpm gen:cp-types   # client types from the core OpenAPI snapshot (--fetch <url> refreshes it)
pnpm profile:init   # dsh profile `human-harness` = web template + link: to the packages
pnpm dev            # build and `dsh --profile human-harness web`
```

Node gotcha: the upstream launcher (`lib/bin.js`) calls `runCli()` only under
`import.meta.main`, which does not exist in Node < 22.18 / < 24.2 — on Node 24.1 `dsh` silently
exits with code 0. The scripts use the wrapper `scripts/dsh.mjs` (`pnpm dsh …`),
which calls `runCli()` explicitly; `DSH_HOME` in the scripts defaults to `~/.dsh`; for an
isolated check set your own (for example a git-ignored directory inside the repository).

Connection exact-route paths allow the segment characters `[A-Za-z0-9_$.-]` — a colon
(`updates:acknowledge` in the core's style) is not allowed, which is why the route is named
`updates.acknowledge`. A mistake in the name silently breaks the whole route inject callback.

Bundle environment variables: `HARNESS_IAM_URL`, `HARNESS_IAM_TENANT`, `HARNESS_IAM_PRINCIPAL`,
`HARNESS_CONTROL_PLANE_URL`, `HARNESS_CONFIRM_MUTATIONS` (see `packages/bundle/cordis.patch.yml`).
`DSH_HOME` switches the dsh home directory (profiles, settings.yaml, credentials).

## The frame instead of AppFrame — how it works

DSH slots are declared by whoever renders them, and the declaration lives as long as the
registration does: shadowing `root` with your own component is not enough — `main` stays
occupied by AppFrame. That is why the bundle disables the `ui-layout` entry (`disabled: true`),
and our plugin provides what the composition loses: `ctx.provide('layout', …)` with the same
contract (`selectPanel`, `beginNavigation`, no-op for sidebar/rightbar),
`ctx.slots.provideRoot({ hooks: { panelInfo } })` for `usePanelInfo`, and the theme presenter
(a port of `theme-presenter.ts`). The root declares only `main`, `sidebar.settings`
and `shell.overlay`: `sidebar` and `rightbar` are not declared, so ui-sidebar and
ui-sidebar-right are not mounted, and the settings seat stays free for
ui-settings-general (the gear at the bottom of the rail). The `harness` theme is a third-party id
that DSH does not persist in its settings; the plugin re-applies it on every `theme/change`.

## Actions from the panels

The approval card in "Important" (and its details) offers "Approve" / "Reject": a review dialog opens
(object, effect, mechanics, reversibility, comment — mandatory on rejection), confirmation
sends `POST /api/harness/approvals.decide`, and the host performs
`POST /api/v1/approvals/{id}:approve|reject` with an `Idempotency-Key`; after success the
projections are re-read (`shell.bump()`), not patched. Task status transitions —
`POST /api/harness/tasks.transition` with `version` for `If-Match` (the UI will arrive together with
`transitions`). The "Assistant" button and the composer open the DSH conversation in the assistant's
workspace, creating it on first use — the directory picker dialog is not shown.

Principal permissions in Control Plane (the IAM↔CP binding) without which the panels are incomplete:
`approvals.read`, `approvals.decide`, `approvals.manage`, `task_types.read`,
`workspaces.read`, `observations.write` — otherwise parts of "Important" are empty (`degraded[]`).

## Scope: the Control Plane workspace

The `tenant / workspace ▾` header selects the core's workspace (the tree `GET /api/v1/workspaces/tree`);
the selection is stored in the per-principal read-state (`$DSH_HOME/harness/read-state.json`, field
`workspaceId`) and acts as the scope: tasks are requested with `workspaceId` +
`includeDescendants`, approvals/runs/events are filtered by the workspace with its descendants
(events without a `workspaceId` in the payload are kept), Search is limited to the same
workspace. The assistant sees the scope in `cp_whoami`/`cp_workspaces`, changes it with
`cp_select_workspace` and substitutes it by default in `cp_find_tasks`,
`cp_create_task`, `cp_recall`, `cp_remember`. "all workspaces" clears the scope.

## v0 boundaries

- The DSH file right panel (`ui-sidebar-right`) and the sidebar session list are not mounted: one conversation per workspace; session switching is the next slice.
- Changing a task's status from its card is not yet exposed in the UI (the route exists, `transitions` are not read); the other mutations go through the assistant with confirmation.
- The interface texts are Russian, in `text.ts`: the DSH language switch knows only `zh`/`en`.
- "Important" rules unavailable to the principal come back in `degraded[]`; the column shows it.
- "Discuss this item" in the conversation with context and live updates from core events come with proactivity (H009); for now "Important" is re-read every 15 s and after every action.
- Persisted `AttentionItem`, defer/snooze, Search/Ask as separate screens — outside the
  slice (ADR-0024 5A-1).

## Updating upstream

The DSH version is pinned: `0.1.7-rc.2` (npm tag `next`). The contracts the code depends on:
the `main` (keyed) and `sidebar.panellist` slots, `ctx.connection.fetch.register`,
`ctx.tools.register(ToolDefinition)`, `ctx.approval.request`, the client bundle format
`window.__ModuleLoader__.load` (the `tsdown.client.ts` preset — a port of upstream).
Check them first when bumping.

## Security and licence

The threat model (the launcher and docker-socket-proxy, networks, what the model in a person's
container can do, secrets, prompt injection) is in [SECURITY.md](SECURITY.md). The code is licensed
under the Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); third-party components,
including DeepSeek Harness (MIT) and the proprietary Claude Agent SDK, are listed in
[THIRD_PARTY.md](THIRD_PARTY.md) (`pnpm third-party` regenerates it).
