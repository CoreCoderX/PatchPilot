# PatchPilot — Engineering Report

## Phase status

| Phase | Status | Date (Asia/Kolkata) |
| --- | --- | --- |
| 1 — Repository audit, requirements, runnable extension foundation | Complete (approved) | 2026-10-12, ~20:35–20:50 IST |
| 2 — Core UI, BYOK, settings, secure state | Complete (approved) | 2026-10-12, ~20:50–21:10 IST |
| 3 — Multi-ecosystem detection and dependency intelligence | Complete (approved) | 2026-10-12 |
| 4 — Upgrade plans, controlled edits, validation, recovery | Complete (approved, commit `71e01c0`). Maven and Python validation were run in Phase 5 (§13). Live model repair was not run (§12.7) | 2026-10-12 |
| 5 — End-to-end verification, packaging, docs, handoff | Complete (approved by user, 2026-10-12) (§13). Real-model repair and interactive modal checks are not validated | 2026-10-12 |

---

## 1. Environment and workspace findings (Phase 1 audit)

| Item | Finding |
| --- | --- |
| Requested Windows workspace `C:\Users\sivap\Downloads\7th_Sem_Proj` | **Not reachable from this environment.** The sandbox is Linux (`e2b.local`, x86_64) with user home `/home/user`. Nothing exists under a Windows path. |
| `/home/user` before work | Empty. No `opencode` or `PatchPilot` folder existed. |
| Action taken (per the setup note) | Cloned OpenCode to `/home/user/opencode` as a read-only reference and created a new Git repository at `/home/user/PatchPilot`. |
| Tools present | Node v20.20.2, npm 10.8.2, Git 2.47.3, Python 3.x, Java (present; not needed for Phase 1). VS Code was not installed; it was downloaded for tests (see §5). |
| Existing PatchPilot work | None. Nothing to preserve. |

**Action needed from you:** this sandbox cannot write to `C:\Users\sivap\Downloads\7th_Sem_Proj`. To use the Windows copy, copy `/home/user/PatchPilot` (and `/home/user/opencode`, if you want the reference clone next to it) into that folder, or tell me the path format that your environment exposes. Everything below was verified on Linux only. Windows behavior has not been tested.

## 2. OpenCode reference audit (read-only)

- Upstream: `https://github.com/sst/opencode`
- Commit inspected: `e41e7e9064f1cb380f0905dd19c611756a577e79` (2026-10-12 HEAD at clone time; project version 2.0.27)
- `git status` in `/home/user/opencode` after inspection: **clean** (no changes made).
- License: **MIT**, `LICENSE` file, "Copyright (c) 2025 opencode". `packages/ai/package.json` also declares MIT.
- Structure: a Bun/Turbo monorepo with ~37 packages. Provider and protocol code lives in `packages/ai`. It is built on Effect and an internal route/schema layer.

### Reuse decisions

| Candidate | Decision | Reason |
| --- | --- | --- |
| `packages/ai/src/providers/openai-compatible.ts` + `protocols/openai-compatible-chat.ts` | **Do not copy.** Phase 2 will write a small fetch-based OpenAI-compatible Chat Completions client against the public API. | Depends on OpenCode's internal `route`, `schema`, and Effect runtime. Porting that would bring in most of the framework, which the brief rules out. Writing a ~200-line client is cheaper and easier to test. |
| `packages/ai/src/protocols/utils/partial-json.ts` (+ options) | **Do not copy now.** | Carries a file-level MIT notice (Promplate Dev Team, 2023). PatchPilot has no partial-JSON streaming need in the current scope. Would require retaining that notice if ever copied. |
| Agent loop, session, TUI, CLI code | **Do not reuse.** | Terminal/runtime architecture; does not fit a VS Code extension. |

Nothing has been copied. `THIRD_PARTY_NOTICES.md` records this decision.

## 3. Architecture and scope (plan for all phases)

### Product scope (unchanged from the brief)
- Ecosystems: npm (`package.json`, `package-lock.json`), Maven (`pom.xml`), Python (`requirements.txt` pinned entries and a defined `pyproject.toml` subset). Documented in Phase 3.
- Evidence sources: OSV for advisories, npm registry, Maven Central metadata, and PyPI JSON for candidate versions.
- Model: BYOK OpenAI-compatible Chat Completions. The model never decides versions, advisories, install results, or test outcomes.
- Mutations (edits, installs, validation commands): always behind explicit user approval and VS Code diff preview.

### Planned module layout

```
src/
  extension.ts                 activation, command registration
  workspaceStatus.ts           pure status model (Phase 1)
  commands/                    command handlers (Phase 2+)
  views/                       activity-bar tree/webview (Phase 2)
  config/ secrets/             settings + ExtensionContext.secrets (Phase 2)
  ai/provider.ts               provider interface
  ai/openai-compatible.ts      fetch-based Chat Completions client (Phase 2)
  ai/context.ts                context selection, redaction, exclusions (Phase 2)
  workspace/trust.ts           trust gate (Phase 2)
  ecosystems/{npm,maven,python}/  parsers + adapters (Phase 3)
  registry/{npm,maven,pypi}.ts    registry clients (Phase 3)
  advisories/osv.ts               OSV client (Phase 3)
  planner/                        upgrade plan (Phase 4)
  edits/                          diff preview, apply, rollback (Phase 4)
  runner/                         allow-listed command runner (Phase 4)
  report/                         REPORT.md writer, redaction (Phase 4)
```

Phase 1 has only `extension.ts` and `workspaceStatus.ts`. The other modules are planned, not created. No empty placeholder files were added.

### Dependency choices (Phase 1)

| Package | Version used | Purpose | License |
| --- | --- | --- | --- |
| `typescript` | 5.9.3 | Compiler | Apache-2.0 |
| `@types/vscode` | 1.105.0 | VS Code API types (matches engines) | MIT |
| `@types/node` | 20.19.x | Node types | MIT |
| `@types/mocha`, `mocha` | 10.0.10, 12.0.3 | Test runner (unit + in-host) | MIT |
| `@vscode/test-electron` | 2.5.2 | Launches VS Code for Extension Host tests | MIT |
| `@vscode/vsce` | 4.0.0 | Packaging VSIX (dev-only) | MIT |
| `eslint`, `typescript-eslint` | 9.39.x, 8.46.x | Lint, strict type-checked rules | MIT |

Runtime dependencies: **none**.

### Decisions I made (routine; recorded here)
- **Engines:** `vscode ^1.105.0`. Tests run on VS Code 1.105.0 (the engines minimum) for reproducibility.
- **Unit tests** use mocha on compiled output. Glob patterns are quoted so Windows `cmd` also works.
- **Test caches** live under `~/.cache/patchpilot-vscode-test`, not the workspace. This keeps the ~150 MB VS Code build and per-run profile out of the saved project snapshot.
- **Untrusted workspaces:** declared `capabilities.untrustedWorkspaces.supported = "limited"`. Phase 1 only reads trust state.
- **Dev-tool upgrades for security:** `npm audit` initially reported 9 findings (7 high, 1 moderate, 1 low). All were in dev-only tooling, and production had 0. I upgraded `mocha` 11 → 12 and `@vscode/vsce` 3.x → 4.0.0. Both now report **0 findings**. No `overrides` were needed.
- **License:** `package.json` says `UNLICENSED` because the project owner has not chosen one. This is a decision for you (see §9).

## 4. Phase 1 implementation (what exists)

### Commands
| Command ID | Title | Behavior |
| --- | --- | --- |
| `patchpilot.showStatus` | PatchPilot: Show Workspace Status | Reads `vscode.workspace.isTrusted` and the open folder paths. Writes a status report to the "PatchPilot" output channel. Reads no project files. Runs no project code. Dependency analysis is shown as "not yet implemented (Phase 3)". |

The command is real and does what it says. It does not pretend a scan happened.

### Files
| File | Purpose |
| --- | --- |
| `package.json` | Manifest, command contribution, untrusted-workspace capability, scripts, pinned dev deps |
| `tsconfig.json` | Strict TypeScript (`strict`, `noUnusedLocals`, `exactOptionalPropertyTypes`, `esModuleInterop`) |
| `eslint.config.mjs` | ESLint flat config with `strictTypeChecked` rules |
| `src/extension.ts` | `activate`/`deactivate`, output channel, command registration |
| `src/workspaceStatus.ts` | Pure `buildStatusReport()` used by the command |
| `src/test/unit/workspaceStatus.test.ts` | 4 unit tests |
| `src/test/runTest.ts` | Launches VS Code 1.105.0 with `test-fixtures/empty-workspace` |
| `src/test/suite/index.ts`, `extension.test.ts` | In-host mocha runner and 2 smoke tests |
| `test-fixtures/empty-workspace/README.txt` | Empty fixture folder used as the test workspace |
| `.vscode/launch.json`, `.vscode/tasks.json` | F5 "Run PatchPilot Extension" and compile task |
| `.vscodeignore` | Excludes source, tests, fixtures, and maps from the VSIX |
| `.gitignore` | `node_modules/`, `out/`, `.vscode-test/`, `*.vsix` |
| `README.md` | Developer setup only (end-user docs come in Phase 5) |
| `THIRD_PARTY_NOTICES.md` | License and provenance record |
| `REPORT.md` | This file |
| `package-lock.json` | Locked dependency tree |

## 5. Tests and checks (actual results)

Environment: Linux (`e2b.local`), Node v20.20.2, npm 10.8.2, TypeScript 5.9.3, mocha 12.0.3, vsce 4.0.0, VS Code 1.105.0 (Linux x64), run under `xvfb-run -a` (virtual display).

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | **Pass** (exit 0) |
| Lint | `npm run lint` (`eslint src --max-warnings=0`) | **Pass** (exit 0, 0 warnings) |
| Unit tests | `npm run test:unit` | **Pass**: 4 passing (buildStatusReport: trusted/untrusted/no-folder/no-analysis-claim) |
| Extension Host smoke test | `npm run test:extension` (via `xvfb-run -a npm test`) | **Pass**: 2 passing (activates + registers `patchpilot.showStatus`; executing the command does not throw) |
| Full suite | `xvfb-run -a npm test` (compile → unit → extension host) | **Pass** (exit 0) |
| Dependency audit | `npm audit` | **Pass**: found 0 vulnerabilities (after upgrades in §3) |
| Packaging | `npm run package` | **Pass**: `patchpilot.vsix`, 6 files, ~5 KB. Contains only `extension/package.json` and `out/extension.js`, `out/workspaceStatus.js` (plus the VSIX manifest files). No test code or source is included. |
| Install into clean VS Code profile | `code --install-extension patchpilot.vsix` (VS Code 1.105.0, separate `--user-data-dir`/`--extensions-dir`) | **Pass**: "successfully installed", `--list-extensions` shows `patchpilot-dev.patchpilot@0.1.0` |
| License scan | script over `node_modules/*/package.json` | Dev-only packages: MIT/ISC/Apache/BSD dominate. Notable: Artistic-2.0 (5 transitive dev packages), `@vscode/vsce-sign` ("SEE LICENSE IN LICENSE.txt", Microsoft dev signing helper). No runtime deps. Details in `THIRD_PARTY_NOTICES.md`. |

Notes on what these results do and do not show:
- The smoke test confirms activation and command registration in a real VS Code host. It does **not** check the text written to the output channel, and it does not test an untrusted-workspace run. Those gaps are recorded in §7.
- The VSIX was installed into a clean profile, but the installed copy was not launched and driven separately. The Extension Host test ran the development copy from the same sources.
- Console noise from the sandbox (D-Bus, GPU process) appears in the logs. It comes from the missing desktop services in the container and does not affect test results.
- Clean-state check: after the final run, `.vscode-test/` does not exist in the workspace. The test download is in `~/.cache/patchpilot-vscode-test`.

## 6. Files modified

Created in `/home/user/PatchPilot` (new Git repo, branch `main`):
`package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `.vscodeignore`, `.vscode/launch.json`, `.vscode/tasks.json`, `src/extension.ts`, `src/workspaceStatus.ts`, `src/test/runTest.ts`, `src/test/suite/index.ts`, `src/test/suite/extension.test.ts`, `src/test/unit/workspaceStatus.test.ts`, `test-fixtures/empty-workspace/README.txt`, `README.md`, `THIRD_PARTY_NOTICES.md`, `REPORT.md`.
Generated (not committed): `out/`, `node_modules/`, `patchpilot.vsix`.

Outside the project: `/home/user/opencode` (cloned, read-only, unmodified); `~/.cache/patchpilot-vscode-test` (test download and profile).

## 7. Known issues and limitations

1. **Windows not tested.** The requested location is not reachable here. Build and tests were verified on Linux only. The npm scripts use only cross-platform commands, but this is unverified on Windows.
2. **Test coverage is minimal by design for Phase 1.** The output-channel text and the untrusted-workspace path are not tested in the Extension Host.
3. **VSIX packaging warnings:** `repository` field missing; no LICENSE file. Both are tied to the open license decision (§9).
4. **Dev-only Microsoft signing tool** (`@vscode/vsce-sign`) carries a non-standard license reference. It is not shipped, but review before any redistribution of tooling.
5. **VS Code test download** (~150 MB, 1.105.0) needs network access on the first `npm test` run and is then cached.
6. **`patchpilot-dev` publisher** is a placeholder. It must be changed before any marketplace publishing.

## 8. Phase 2 proposal (awaiting approval)

Phase 2 — Core UI, BYOK, settings, and secure state:
- Activity-bar view with a scan-results placeholder that shows real state only. It must not look like a working scan.
- Settings: `patchpilot.ai.baseUrl` (default `https://api.openai.com/v1`), `patchpilot.ai.model`, and exclusion patterns. **No API key in settings.**
- Secure key flow: `PatchPilot: Set Model API Key` and `PatchPilot: Clear Model API Key` via `ExtensionContext.secrets`. The key is never logged, written to a file, or sent as prompt content.
- Provider interface plus a fetch-based OpenAI-compatible Chat Completions client. Streaming, `AbortSignal` cancellation, timeouts, and error mapping for 401/403, 429 (rate limit), 5xx, malformed JSON, and network failures.
- Consent gate before any model call: shows the exact endpoint host and a data-sharing warning.
- Unit tests with mocked HTTP only (no live credentials). Tests verify the key does not appear in logs, prompts, or reports.
- Workspace trust gate wired into the model-backed command path.

Phase 2 will not scan dependencies or call registries. That is Phase 3.

## 9. Decisions needed from you

1. **Approve Phase 2** (explicit approval required).
2. **Project license:** pick one (e.g., MIT, Apache-2.0, or proprietary). It affects `package.json` and the packaging warnings.
3. **Windows location:** confirm how the project should be placed in `C:\Users\sivap\Downloads\7th_Sem_Proj\PatchPilot`, since this sandbox cannot reach it.

---

## 10. Phase 2 — Core UI, BYOK, settings, and secure state

Status: **complete** (approved). Date: 2026-10-12, ~20:50–21:10 IST.

### 10.1 What was implemented

**Activity bar and overview view**
- Activity-bar container "PatchPilot" (`media/patchpilot.svg`) with an "Overview" tree view (`patchpilot.overview`).
- Rows reflect checked state only: workspace trust, model endpoint and model ID (or "Not configured"), API key presence (never its value), last connection test in this session, and dependency analysis ("Not available yet", no command attached).
- Each row has a tooltip and accessibility label. Rows with actions open the matching command.
- Verified in a real VS Code 1.105.0 window (see 10.5).

**Commands** (all in the Command Palette under "PatchPilot")
| Command ID | Title | Behavior |
| --- | --- | --- |
| `patchpilot.showStatus` | Show Workspace Status | Unchanged from Phase 1 (output channel). |
| `patchpilot.setApiKey` | Set Model API Key | Password input box, validated, stored in `context.secrets`. |
| `patchpilot.clearApiKey` | Clear Model API Key | Modal confirmation, then deletes the secret. |
| `patchpilot.testConnection` | Test Model Connection | Consent prompt, then one fixed test request with a cancellable progress notification. |
| `patchpilot.openModelSettings` | Open Model Settings | Opens Settings filtered to `patchpilot`. |

**Settings** (`patchpilot.*`)
| Setting | Default | Scope | Notes |
| --- | --- | --- | --- |
| `patchpilot.ai.baseUrl` | `https://api.openai.com/v1` | application | `https`, or `http` only for localhost/127.0.0.1/[::1]. No credentials, query, or fragment. |
| `patchpilot.ai.model` | `""` | application | Required before any model action. Allowed characters: letters, digits, `. _ : / @ -`. |
| `patchpilot.ai.timeoutSeconds` | `60` | application | Whole number, 5–300. |
| `patchpilot.context.excludePatterns` | `[]` | window | Extra exclusions. Built-in secret-file patterns always apply and cannot be removed. |

Application scope means a project's `.vscode/settings.json` cannot change the endpoint or model, so a repository cannot redirect the API key to another host.

**BYOK provider layer**
- `ChatProvider` interface (`src/ai/types.ts`) keeps the agent independent of any one vendor.
- `OpenAICompatibleProvider` (`src/ai/openaiCompatible.ts`) is a fetch-based Chat Completions client. It sends `stream: true`, reads SSE deltas, and falls back to a plain JSON body if the server does not stream.
- Total request timeout, cancellation through `AbortSignal`, and no automatic retries (rate limits are reported with `Retry-After`).
- Error kinds: `missing_key`, `invalid_config`, `auth` (401/403), `rate_limited` (429), `bad_request` (other 4xx), `server` (5xx and in-stream errors), `network`, `timeout`, `cancelled`, `invalid_response` (malformed JSON, unexpected shape, empty text).
- Error text is redacted (see 10.3) and capped at 2000 characters.

**Consent and trust gate**
- Every model call goes through one path in `src/commands/modelCommands.ts`. It checks settings, then the trust gate (`src/workspace/trustGate.ts`), then reads the key, then shows a modal consent prompt before sending anything.
- The consent prompt names the full endpoint, the receiving host, the model, exactly what data is sent, and the number of active exclusion patterns.
- Consent is asked for every send. Nothing is remembered.
- Connection tests send no workspace content, so they are allowed in restricted mode. Any action that sends workspace content (Phase 3 onward) is blocked in an untrusted workspace by `gateModelAction`.

**Secure key handling** (`src/secrets/apiKeyStore.ts`)
- One secret per provider, `patchpilot.ai.apiKey.openai-compatible`, stored only in `ExtensionContext.secrets`.
- Keys are trimmed and rejected if empty, longer than 4096 characters, or containing whitespace.
- The store remembers values it has handled in this session, only so the logger can mask them.

**Logging and redaction**
- `RedactingLogger` (`src/log.ts`) writes to the "PatchPilot" output channel. Every line passes through `redactSecrets`, which masks known key values, Bearer tokens, `sk-` shaped strings, and `api_key`/`authorization` assignments.

### 10.2 Files added or changed in Phase 2

Added: `src/ai/{errors,types,endpoint,sse,openaiCompatible}.ts`; `src/config/aiSettings.ts`; `src/secrets/apiKeyStore.ts`; `src/security/{redact,exclusions}.ts`; `src/workspace/trustGate.ts`; `src/log.ts`; `src/commands/modelCommands.ts`; `src/ui/{consentText,overviewModel,overviewView,vscodeModelUi}.ts`; `media/patchpilot.svg`; unit tests under `src/test/unit/` (`helpers.ts`, `endpoint`, `sse`, `redact`, `openaiCompatible`, `openaiLocalServer`, `apiKeyStore`, `aiSettings`, `exclusions`, `trustGate`, `consentAndOverview`, `modelCommands` tests).

Changed: `src/extension.ts` (wiring; now returns a small test API), `src/workspaceStatus.ts` (status text updated for Phase 2), `src/test/suite/extension.test.ts` (Extension Host tests), `package.json` (version 0.2.0, view container, commands, configuration, untrusted-workspace capability text), `tsconfig.json` (unchanged this phase), `README.md`, `THIRD_PARTY_NOTICES.md`, `REPORT.md`.

No new runtime or dev dependencies were added in Phase 2.

### 10.3 Key-safety verification (what was checked, and how)

| Requirement | Evidence |
| --- | --- |
| Key stored only in secret storage | Unit: `apiKeyStore.test.ts` checks the only write goes to the secret name. Host: round-trip through real `context.secrets`. Source audit: no `globalState`, `workspaceState`, file writes, or telemetry in `src/` (grep, see 10.5). |
| Key not in settings | Host test checks `inspect()` of settings does not contain the probe value. |
| Key not in request body or prompt | Unit: `openaiCompatible.test.ts` ("never places the API key in the prompt content"); local-server test checks the request body; `modelCommands.test.ts` checks the message array. |
| Key sent only as bearer header | Local-server test reads `authorization` on a real loopback server and checks it equals `Bearer <key>`. |
| Key not in logs or user-visible messages | `modelCommands.test.ts` checks the output log and every info, warning, error, and consent message after set, and after a 401 that echoes the key. |
| Key not in error objects | `openaiCompatible.test.ts`: a 401 body that echoes the key, and a network error that contains the key, both come back redacted. |
| Key not in overview | Host test: overview rows contain no key value. Rows hold only booleans and labels. |
| Key not in reports | No report generator exists yet (Phase 4). `REPORT.md` writing will use the same redactor. Phase 4 must add a test for this. |

### 10.4 Commands run and results (actual)

Environment: Linux (`e2b.local`), Node v20.20.2, npm 10.8.2, TypeScript 5.9.3, VS Code 1.105.0, run under `xvfb-run -a`.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | Pass, exit 0 |
| Lint | `npm run lint` (`eslint src --max-warnings=0`) | Pass, exit 0 |
| Unit tests | `npm run test:unit` | **97 passing**, 0 failing |
| Extension Host tests | `npm run test:extension` (via `npm test`) | **5 passing**, 0 failing |
| Full suite | `xvfb-run -a npm test` | Pass, exit 0 |
| Dependency audit | `npm audit` | 0 vulnerabilities |
| Packaging | `npm run package` | `patchpilot.vsix`, 23 files, ~24 KB. Test code excluded (0 `/test/` entries); `media/patchpilot.svg` and the manifest included. |
| Clean install | `code --install-extension patchpilot.vsix` into a fresh profile | Installed `patchpilot-dev.patchpilot@0.2.0` |

Unit tests run without network access or credentials. The local-server tests use a loopback server only.

### 10.5 Visual and manual verification

- A screenshot of the Extension Development Host (VS Code 1.105.0, virtual display) shows the PatchPilot activity-bar icon and the "Overview" rows: Workspace trust (Trusted), Model settings (Not configured, after a fix made during this check), API key (Not set), Last connection test (Not run this session), and Dependency analysis (Not available yet). The PatchPilot output channel shows the status report.
- Found and fixed during this check: an empty model ID showed as "Invalid" when it is simply not configured yet. The overview now shows "Not configured", and an Extension Host assertion covers it.
- Not verified in this environment: clicking through the modal consent prompt, the input box, the progress notification, and cancellation in the real UI. These are covered by the command-level unit tests with fake UI, not by driving the real VS Code dialogs. A live model call was not made, since no credentials were provided and none should be used for tests.

### 10.6 Known issues and limitations (Phase 2)

1. **Only one provider** (OpenAI-compatible). Other providers will need their own `ChatProvider` implementation.
2. **Connection test uses the consent gate, not a "send workspace content" flow.** The gate that blocks workspace content in restricted mode is implemented and unit-tested, but no Phase 2 command sends workspace content, so it is not exercised end to end yet.
3. **Context exclusions are configured and merged, but not yet applied** to any outgoing data, because no workspace content is sent in Phase 2. They will be enforced in Phase 3/4, with tests then.
4. **No live endpoint test.** Streaming was tested against a local loopback server, not a real hosted API. Vendor-specific quirks may appear.
5. **Session-only last-test state.** The overview's "Last connection test" resets when VS Code restarts.
6. **Windows still not tested** (see Phase 1, §7).
7. **Extension version bumped to 0.2.0** in `package.json`.

### 10.7 Phase 3 proposal (awaiting approval)

Phase 3 — Multi-ecosystem detection and dependency intelligence:
- Workspace detector for `package.json`/`package-lock.json`, `pom.xml`, `requirements.txt`, and a defined `pyproject.toml` subset. Detection runs only in trusted workspaces.
- Parsers that report unsupported formats and unparseable files explicitly rather than skipping them silently. Lockfile support starts with the common npm `lockfileVersion` values (2 and 3).
- OSV client (batch query by ecosystem and package identity) and registry clients: npm registry, Maven Central metadata, PyPI JSON. All network use is shown through the consent gate, and the request contains package names and versions only, never source code.
- Separate findings for vulnerable, outdated, deprecated, unsupported, and compatibility-unknown. Each finding records source URL, queried version, timestamp, and advisory IDs.
- Results tree grouped by project, dependency, and issue type. Read-only: no edits and no package-manager commands in Phase 3.
- Fixture-based tests for each ecosystem, including malformed files, no dependencies, version ranges, and unavailable registries. Tests use mocked HTTP.

Phase 3 will not change files, install packages, or run project scripts.

## 11. Phase 3 — Multi-ecosystem detection and dependency intelligence

Status: **complete**, pending your approval for Phase 4. Approved scope: "yes proceed". Phase 3 is read-only: no file edits, no package-manager commands, no project scripts.

### 11.1 What was implemented

**Command and flow** (`patchpilot.analyzeDependencies`, "PatchPilot: Analyze Dependencies")
1. Restricted (untrusted) workspace: blocked before any file is read.
2. File discovery with `workspace.findFiles` for manifests and lock files. Excluded directories include `node_modules`, `.git`, `.venv`, `target`, `build`, `dist`, `out`, `bin`, `obj`, `vendor`. Candidates are stat-ed but not read yet.
3. Local parse only: manifests and the npm lockfile are read and parsed. Nothing leaves the machine yet.
4. **Consent gate, before the first request.** The prompt lists the manifests read locally, each endpoint with exact counts of package names and OSV queries, and states that only names and versions are sent. Declining sends nothing. Tested: a declined run makes zero client calls.
5. Bounded lookups with progress and cancellation: registry lookups (4 concurrent), OSV batches (100 queries per request, paginated), advisory summaries (up to 200 IDs).
6. Results appear in the new **Dependencies** view (`patchpilot.dependencies`). The overview's "Dependency analysis" row opens the command, or says "Needs trusted workspace".

**Detection** (`src/analysis/detect.ts`)
- Supported: `package.json` (+ `package-lock.json`), `pom.xml`, `requirements*.txt`, `pyproject.toml`.
- Reported, not analyzed: `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `poetry.lock`, `Pipfile`, `Pipfile.lock`, `setup.py`, `setup.cfg`, Gradle build and lock files.
- Cap: 50 manifests, shown in the results when reached.

**Parsers** (`src/ecosystems/`)
- npm: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`. Lockfile v1, v2, v3 (top-level `node_modules/<name>` entries only). Other lockfile versions are reported and ignored. Specifiers classify as exact, range, unpinned, or unresolved (git, file, URL, alias, dist-tag).
- Maven: `groupId:artifactId`, `${property}` resolution (including `project.version`), `dependencyManagement` lookups, parent-inherited versions marked "managed" (not resolved), test scope → development, optional → optional. Ranges and unresolved properties are labelled.
- Python requirements: comments, backslash continuations, `--hash` stripped, environment markers recorded but not evaluated, `==` exact, ranges, unpinned. `-r`/`-c` includes are reported and not followed. `-e`, VCS, and URL lines are reported as unsupported. Index-option lines are reported and ignored.
- `pyproject.toml`: PEP 621 `[project].dependencies` and `[project.optional-dependencies]`. Poetry tables and PEP 735 `[dependency-groups]` are reported.
- Malformed files give a "malformed" issue and no dependencies. Invalid entries give "skipped-entry" issues. Nothing is dropped silently.

**Registry clients** (`src/registry/`): one bounded HTTP helper (timeout, 25 MB cap, no retries; 404 → not-found; 429 and 5xx → unavailable with reason). Endpoints:
- npm: `https://registry.npmjs.org/<name>` with the abbreviated packument accept header (`dist-tags.latest`, per-version `deprecated`).
- Maven Central: `https://repo1.maven.org/maven2/<group path>/<artifact>/maven-metadata.xml` (`release`, versions; Maven ordering for stable selection).
- PyPI: `https://pypi.org/pypi/<normalized>/json` (`info.version`, releases, yanked when all files are yanked).

**OSV client** (`src/advisories/osv.ts`): `POST https://api.osv.dev/v1/querybatch` with pagination tokens, and `GET /v1/vulns/{id}` for summaries. Advisory IDs are validated. A failed batch marks its queries unknown.

**Assessment** (`src/analysis/assess.ts`): each dependency gets four separate results.
- Vulnerability: vulnerable / no-known-advisories / unknown (with reason). Checked only for the lockfile version or an exact pin. Range-only declarations are unknown.
- Freshness: current / outdated / range-satisfied / range-excludes-latest / unknown. npm and PyPI ranges are evaluated; Maven ranges are not.
- Deprecation: npm only, by version. Maven and PyPI report unknown. A PyPI yank is recorded as evidence, not as a deprecation.
- Compatibility: always unknown in this phase.
- Evidence entries record source, URL, detail, and retrieval time.

**Version ordering** (`src/analysis/versions.ts`): Maven qualifier ordering, PEP 440 release/pre/post/dev ordering, and specifier matching. npm uses the `semver` package.

**Runtime dependencies added**: `fast-xml-parser` 5.11.2 (MIT), `smol-toml` 1.9.1 (BSD-3-Clause), `semver` 7.8.x (ISC). Listed in `THIRD_PARTY_NOTICES.md`.

### 11.2 Files added or changed in Phase 3

Added: `src/analysis/{types,versions,detect,assess,runner,clients,consent}.ts`; `src/ecosystems/{npm,maven,pypi}.ts`; `src/registry/{http,npm,maven,pypi}.ts`; `src/advisories/osv.ts`; `src/commands/analyzeCommand.ts`; `src/ui/{dependencyModel,dependencyView}.ts`; `src/test/unit/parsers.test.ts`; `src/test/unit/analysisRun.test.ts`.

Changed: `src/extension.ts` (command, view, file discovery); `src/workspaceStatus.ts` and `src/ui/overviewModel.ts` (analysis is no longer "not available"); `src/test/suite/extension.test.ts` (command registration); Phase 2 tests updated for the new status text; `package.json` (version 0.3.0, command, view, runtime dependencies, trust text, `package` script); `package-lock.json`; `README.md`; `THIRD_PARTY_NOTICES.md`; `REPORT.md`.

### 11.3 Decisions made during the phase (routine; recorded here)

- **Packaging changed.** `vsce package --no-dependencies` would have left the three runtime packages out of the VSIX, and the extension would have failed to load. The `package` script now bundles production dependencies. Verified by extracting the VSIX and loading the Maven, PyPI, and npm parsers from it.
- **Multi-root paths.** Without the folder name, two folders with the same `package.json` would collide. The folder name is now included when more than one folder is open. Found in review; not covered by an automated test.
- **`XMLValidator` suppression.** `fast-xml-parser` 5 deprecates its bundled `XMLValidator` in favor of a separate package. I did not add a dependency mid-phase. The two call sites carry an `eslint-disable` with that reason.
- **Lockfile versions.** All of npm lockfile v1, v2, and v3 are read. The Phase 3 proposal said "2 and 3"; v1 was added because it is common in older projects.

### 11.4 Commands run and results (actual)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint (strict type-checked) | `npm run lint` | exit 0, 0 warnings |
| Unit tests | `npm run test:unit` (inside `npm test`) | **143 passing**, 0 failing (97 from Phase 2, 46 new) |
| Extension Host | `xvfb-run -a npm test` | **5 passing** (includes registration of `patchpilot.analyzeDependencies`) |
| Dependency audit | `npm audit` | found 0 vulnerabilities |
| Package | `npm run package` | `patchpilot.vsix`, 213 files, ~427 KB, includes runtime `node_modules` |
| VSIX runtime check | extract the VSIX; run the three parsers from `extension/out` | parsed Maven, PyPI, and npm inputs correctly |
| Live smoke test | `runAnalysis` with the real clients on a fixture (lodash 4.17.15, express ^4.18.0, left-pad 1.3.0, requests 2.19.0, flask range, commons-lang3 3.5, junit test scope, `@types/node` range) | completed in ~1 s; all four services answered |

Live smoke results (real data, 2026-10-12):
- lodash 4.17.15: vulnerable (several advisories), outdated (latest 4.18.1).
- requests 2.19.0: vulnerable (several advisories), outdated (latest 2.34.2).
- commons-lang3 3.5: vulnerable (GHSA-j288-q9x7-2f5v and others), outdated (latest 3.21.0).
- left-pad 1.3.0: deprecated on npm; no advisories; current.
- express `^4.18.0`: range excludes latest 5.3.0 (a range, so no OSV check).
- Sources: npm 4/4, Maven 2/2, PyPI 2/2, OSV 5/5 queries, 17/17 advisory summaries.

Unit tests (fake clients and fixture JSON/XML; no live network in tests) cover: malformed files, empty projects, invalid entries, npm lockfile v1/v2/v3 and unsupported versions, ranges, unresolved specifiers, property and managed-version resolution, pagination, 404/429/5xx/oversize/network-error mapping, unavailable registries (source marked unavailable, freshness unknown, OSV still reported), OSV outage, cancellation before requests, declined consent (zero requests), consent counts, result ordering, PyPI yank evidence, and the restricted-mode block.

### 11.5 Visual and manual verification

- **Consent dialog in a real window: not verified.** I attempted it. VS Code's test host refuses modal dialogs ("DialogService: refused to show dialog in tests"), so the consent prompt did not appear on screen. The error path handled this: it logged the failure and showed a toast. In a normal window the modal should appear, but I could not confirm that here.
- **Dependencies view: not visually checked.** Its model is covered by unit tests, and its registration by the Extension Host test.
- The command was run end-to-end in the extension host with the real analysis and a fake UI for the modal, so the pipeline and consent counts were exercised.

### 11.6 Known issues and limitations (Phase 3)

- **Direct dependencies only.** No transitive graph. Maven dependency trees are deferred because they need `mvn`, which Phase 3 does not run.
- **Maven parent POMs are not resolved.** Inherited versions are marked "managed". Maven ranges are not evaluated.
- **Ranges are not OSV-checked.** Only lockfile versions and exact pins are checked, as approved.
- **npm lockfile scope.** Top-level entries only. Nested versions and workspaces are not analyzed. Yarn and pnpm locks are reported as unsupported.
- **No caching and no retries.** Each run queries the services again; failures show as unavailable.
- **Consent modal appears while the progress notification is running.** A UI detail, not a safety gap.
- **Real-window UI not verified** (see 11.5). Windows untested, as in Phase 2.
- **Exclusion patterns do not filter these lookups.** Outgoing data is limited to names and versions, so no file contents can leak; the Phase 2 exclusions apply to model sends only.
- **Advisory data is a point-in-time snapshot.** "No advisories" means none found at that time, not "safe".
- **Phase 2 limitations still apply:** one provider, no live model endpoint test, restricted-mode content gate unit-tested only.

### 11.7 Phase 4 proposal (awaiting approval)

Phase 4 — Upgrade plans, controlled edits, validation, recovery:
- Plans are generated from Phase 3 findings. Each plan shows its file edits and any commands, and each needs explicit approval.
- Edits are applied only in the trusted workspace, with a snapshot taken first so every edit can be rolled back.
- Project commands (install, test, build) run only after approval, with output captured and reported as validation results.
- Recovery restores the snapshot if validation fails, so a failed step leaves the workspace as it was.

Phase 4 is not authorized. It needs your approval before any edit or command is implemented.

---

## 12. Phase 4 — Upgrade plans, controlled edits, validation, recovery

Status: **implemented and verified in this sandbox, with the gaps listed in 12.7.** Awaiting your approval before Phase 5. Phase 4 was started under the "Proceed to next" approval. Scope follows the design decided in planning (recorded in 12.1).

### 12.0 Repository state found at the start of Phase 4 (read this first)

- The project folder had **no `.git` directory** when Phase 4 started. The Phase 3 commit `a326359` and the earlier commits `163db6d` and `b06547f` could not be found anywhere in the sandbox. The source tree, `package.json` (version 0.3.0), and `REPORT.md` §11 were intact, so the restore kept the files but not the history.
- To keep Phase 4 reviewable, I ran `git init` and made one commit of the restored Phase 3 state, titled "Baseline: restored Phase 3 state". That commit is **not** the original Phase 3 commit, and its hash does not match `a326359`. Phase 4 is committed on top of it.
- Dependencies were reinstalled with `npm ci` from the lockfile. The VS Code test cache was re-downloaded (VS Code 1.105.0). Two Linux libraries were installed with `apt` (`libnspr4`, `libnss3`, and related GTK/ALSA packages) so VS Code could start. These are environment changes, not project changes.

### 12.1 Design (decided before coding)

- **Scope.** Single workspace folder only. Multi-root workspaces are refused with a message. Ecosystems: npm, Maven, and the Python subset from Phase 3.
- **Entry point.** Plan Upgrade reuses the last analysis result. If there is none, it runs analysis first, which has its own consent step. Then it runs a second consent-gated OSV query for candidate target versions.
- **What gets a plan item.** Dependencies that are vulnerable or npm-deprecated. Outdated-only dependencies are not planned (decided: avoids churn; the user did not ask for general upgrades).
- **Target.** The highest stable candidate above the current version that has zero OSV advisories. Candidates are the top 5 newest stable versions. Excluded: pre-releases, npm-deprecated versions, PyPI-yanked versions. If no candidate qualifies, the item is blocked. Compatibility is always reported as "not verified".
- **Only exact pins are edited.** `package.json` (exact string), `requirements*.txt` (`name==x` on one line), `pyproject.toml` (PEP 621 `"name==x"`), and Maven `<version>` literal directly after the groupId/artifactId pair. Ranges, property-derived versions, managed versions, and lockfile-vs-manifest mismatches are reported as blocked.
- **npm lockfile.** Refreshed by the approved command `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. Its exact effect cannot be previewed, and the review says so.
- **Validation.** Fixed templates only (`npm test`, `npm run build`, `mvn -B -q dependency:resolve`, `mvn -B -q test`, `python -m pip install --dry-run --quiet -r <file>`, `python -m pytest -q`). Run with no shell. Exception: on Windows, `npm` and `mvn` are `.cmd` shims, which Node can only launch through a shell. Their arguments are still fixed template strings, and the only variable argument is a validated file name. Output is capped at 16 KB, redacted, and timeouts are configurable.
- **Snapshots.** Extension storage: `plans/<id>/steps/NNN/` holds before-copies, `step.json` with SHA-256 hashes, and the record. Rollback verifies hashes.
- **Model repair.** The model must return `{"edits":[{path,search,replace}]}`. Each `search` must occur exactly once in an allowed source file. Manifests and lockfiles are never editable by the model. Consent is shown before each send. Default maximum 2 attempts, with repeated-failure detection.

### 12.2 What was implemented

**Plan** (`src/upgrade/planner.ts`, `targets.ts`, `edits.ts`)
- `prepareCandidates` (pure): picks items and candidate versions and lists the OSV queries they need. Makes no network call and reads no file.
- `finalizePlan`: chooses the target for each item from the OSV counts, applies each edit, and checks that package.json still parses as JSON. An item whose edit does not match exactly once is blocked, and nothing is written for it.
- Block reasons are explicit: `not-exact-pin`, `lock-manifest-mismatch`, `no-registry-data`, `no-newer-stable`, `candidate-check-unavailable`, `no-clean-candidate`, `edit-not-found`, `edit-not-unique`.

**Apply** (`src/upgrade/workflow.ts`, `store.ts`)
1. Refuse unless the plan is `proposed`.
2. Hash every file to be edited against the hash recorded at planning time. Any mismatch refuses the whole apply and writes nothing.
3. Start a snapshot step, copying every file that will change (including the lockfile when the refresh command is selected).
4. Write the edits, then run the selected apply-phase commands. Each command is checked again just before it starts.
5. If a write or command fails, roll back the step and report "failed, reverted" with the rollback result.
6. Record the after-hashes and set the plan to `applied`.

**Validate** (`validatePlan`, `summarizeValidation`): runs the selected validation commands in order. Results: `validated`, `partially-validated`, `validation-failed`, or `unresolved`. Re-validation is allowed after a success (for example, after a manual fix).

**Rollback** (`SnapshotStore.rollback`): reverses every unrolled step in reverse order. A file is restored only if its current hash matches the hash PatchPilot recorded after writing it, or its original hash. A file the user changed since is reported as a conflict and left alone. A restored file's hash is checked against the original. Only a fully verified rollback is reported as verified.

**Repair** (`src/upgrade/repair.ts`, `workflow.ts repairLoop`)
- Candidate files: editable source files in the failing command's folder whose names appear in the output. If none, files that mention a changed dependency name. At most 8 files, 60 KB each, 120 KB total.
- Each attempt: consent prompt with the exact file list and redacted output excerpt → one model call → strict JSON parse (a code fence is tolerated, anything else is refused) → exact-once check in memory → diff approval → snapshot step → write → re-run the selected validation commands.
- Stops: `validated`, `max-iterations`, `repeated-failure` (same command and normalized output fingerprint as an earlier attempt; digits masked), `declined`, `no-candidates`, `model-error`, `cancelled`.
- Repair requires a trusted folder (it sends workspace content and runs commands).

**Commands and UI**
- `patchpilot.planUpgrade`, `patchpilot.reviewAndApply`, `patchpilot.validateChanges`, `patchpilot.repairWithModel`, `patchpilot.rollbackChanges`.
- Plan view (`patchpilot.plan`): plan header, dependency items with reasons and advisories, files, commands with their exact display line, command results (last 20 with output tail), snapshot steps, and notes.
- Diffs: before apply and before repair writes, VS Code diff editors open (`vscode.diff`, current vs proposed, read from memory).
- Settings (validated; out-of-range values are rejected, not clamped): `patchpilot.upgrade.commandTimeoutSeconds` (default 300, 10–3600), `patchpilot.upgrade.repairMaxIterations` (default 2, 1–5).

**Approvals and gates**
- Trusted folder required for plan, apply, validate, repair, and rollback.
- Plan: one consent prompt for candidate OSV queries, with the count. Declined means no request is sent.
- Apply: diffs opened, then one modal approval listing every changed file and every command line.
- First validation run of each plan: one modal listing each command, its working directory, and its purpose. Approval is stored on the record.
- Each model send: consent prompt. Each repair write: diff approval.

**Files added** (`src/upgrade/`): `types.ts`, `edits.ts`, `targets.ts`, `commands.ts`, `planner.ts`, `planSummary.ts`, `exec.ts`, `store.ts`, `repair.ts`, `workflow.ts`. Commands and UI: `src/commands/upgradeCommands.ts`, `src/config/upgradeSettings.ts`, `src/ui/{planModel,planView,diffPreview,vscodeUpgradeUi}.ts`. Changed: `src/analysis/{types,runner}.ts` (the result now carries registry evidence), `src/extension.ts`, `package.json` (version 0.4.0), `package-lock.json` (version field only), tests.

**Dependencies.** No new runtime dependency. Node built-ins only. `THIRD_PARTY_NOTICES.md` is unchanged.

### 12.3 Decisions made during the phase (routine; recorded here)

- Validation approval is asked once per plan, not before every command, because the first prompt already lists every command. Repair attempts reuse that approval.
- `npm test` is planned only when `scripts.test` exists and is not npm's placeholder ("no test specified").
- `pytest` is planned only when a `tests/` or `test/` folder exists.
- The display line uses the same executable the runner spawns (`python3` on Linux, `python` on Windows), so approval matches execution. Found by a failing test during the phase.
- A rollback of a step that never finished does not check the after-hash, because the write may have stopped partway. Restoring the before-copy is the only safe action in that case.
- The apply precheck requires every file to match its planned hash. Any drift stops the whole apply.

### 12.4 Commands run and results (actual)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint (strict type-checked, 0 warnings) | `npm run lint` | exit 0 |
| Unit tests | `npm run test:unit` (inside `npm test`) | **237 passing**, 0 failing (143 from before Phase 4, 94 new) |
| Extension Host | `DISPLAY=:99 npm test` | **7 passing** in VS Code 1.105.0 (5 from before, 2 new: Phase 4 commands and config/Plan view registration) |
| Dependency audit | `npm audit` | found 0 vulnerabilities |
| Package | `npm run package` | `patchpilot.vsix`, 229 files, 461.82 KB; test code not included (checked) |
| **Live end-to-end** | `/tmp/e2e/run.js` (outside the project): real analysis, real OSV, real `npm test` through the allowlisted executor, real apply, rollback | see 12.5 |

Unit test coverage by area: edit rules for all four pin forms (uniqueness, property refusal, separators, extras, markers, comments), candidate selection (pre-release, deprecated, yanked, top-5 limit), OSV-based target choice, every block reason, manifest JSON validity, Windows and POSIX executable names, command template and cwd checks, redaction, timeouts, cancellation, output capping, snapshot restore for edited/new/conflicting/tampered files, apply conflict (no writes), apply failure with rollback, validation statuses, repair parsing (fences, prose, wrong shapes, paths outside the allowlist), exact-once repair edits, repeated-failure stop, manifest refusal, consent decline (zero model calls), rollback after repair, multi-root refusal, untrusted refusal, OSV consent decline (zero requests), and the Plan view model.

### 12.5 Live verification (real network and real npm)

Fixture: `package.json` with `lodash` 4.17.15 (exact pin) and `express` `^4.18.0` (range), and `"test": "node test.js"`. No model call was made.

- Analysis: npm registry 1/1 ok; OSV ok. lodash 4.17.15 **vulnerable** with six advisories (GHSA-29mw-wpgm-hmr9, GHSA-35jh-r3h4-6jhm, GHSA-f23m-r3pf-42rh, GHSA-p6mc-m468-83gw, GHSA-r5fr-rjxr-66jc, GHSA-xxjr-mmjv-4gpg). express: range, not checked, no plan item.
- Candidates: 5 OSV queries (4.18.1, 4.17.23, 4.17.21, 4.17.20, 4.17.19). Advisory counts 0, 2, 3, 5, 5. **Target 4.18.1** (newest with zero advisories).
- Plan: `package.json` edit `4.17.15 → 4.18.1`; validation command `. $ npm test`.
- Apply → `npm test` passed (`tests ok`) → validated. Rollback: `restored and hash verified`; file identical to the original.
- Variant with `package-lock.json` (generated first by the approved refresh command): plan adds `. $ npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. Apply ran it, the lockfile changed (it now mentions 4.18.1), validation passed, and rollback restored **both** files byte-for-byte.

### 12.6 Visual and manual verification

- **Not verified on screen:** the modal review, apply, validation, and repair confirmations, the diff editors, and the Plan view tree. The Extension Host harness refuses modal dialogs (see §11.5), so these were not seen in a real window. Their logic is unit-tested through the injected UI.
- Plan view registration is verified (Extension Host). Its rendering is not.

### 12.7 Known issues and limitations (Phase 4)

- **Maven validation was not executed.** `mvn` is not installed in this sandbox. The Maven edit rules and planning are unit-tested, but `maven-dependency-resolve` and `maven-test` have never run here. Status: **unresolved**.
- **Python validation was not executed live.** `pip --dry-run` and `pytest` are unit-tested for argv and planning only. Status: **unresolved**.
- **Model repair was tested with a fake provider only.** No live model endpoint is configured in this sandbox. The loop, parsing, edit rules, consent, and stop conditions are covered by unit tests. Status: **partially validated**.
- **Windows is untested**, as in earlier phases. The `.cmd` shim path and the `python` name are unit-tested only.
- **Compatibility of target versions is not verified.** It is always reported as such, by design.
- **Outdated-only dependencies are not planned.** Decided (see 12.1).
- **Transitive dependencies are not handled.** Only direct, exact-pinned dependencies are edited.
- **npm lockfile refresh cannot be previewed**, by design. The review says so, and the diff afterwards shows the result.
- **Rollback of an unfinished step** restores the before-copy without checking the after-hash (see 12.3).
- **Snapshot storage** uses the workspace storage folder (`context.storageUri`), with global extension storage as a fallback. Planning is refused without a single open folder, so no plan is created in that case.
- **Single workspace folder only.** Multi-root is refused.
- **Repair candidate selection is heuristic.** If the failing output does not name a source file and no file mentions a changed dependency, repair stops with "no candidates" and sends nothing.
- **Phase 3 limitations still apply** (no transitive graph, advisory snapshot, Maven parent POMs unresolved, npm lockfile top-level entries only).

### 12.8 Phase 5 proposal (awaiting approval)

Phase 5 — End-to-end verification, packaging, docs, handoff:
- Run the full pipeline on a fixture for each ecosystem, including `mvn` and `pip` if they can be installed here, and record each result as validated, partially validated, unresolved, or failed/reverted.
- Exercise the modal and diff flows in a real window (or a test seam that does not change production consent behaviour), and record what was seen.
- Test a live model endpoint with a repair attempt, if the user provides an endpoint and key through the normal BYOK flow.
- Finish README, the user guide, the security notes, and the handoff; package the final VSIX and confirm its contents.

Phase 5 is not authorized. It needs your approval before any further work.

---

## 13. Phase 5 — End-to-end verification, packaging, documentation

### 13.1 What was done

- Added `samples/` (four small projects: `npm-vuln`, `npm-repair`, `maven-vuln`, `python-vuln`) and `samples/README.md`.
- Added `scripts/e2e-samples.js` and the `npm run e2e` script. It copies each sample to a temporary folder and runs the real workflow: analysis (live registries and OSV), plan, apply with approved commands, validation, repair (npm-repair only), and rollback with a byte-for-byte check. Each step is printed.
- Excluded `samples/**` and `scripts/**` from the VSIX.
- Fixed two issues found by the first end-to-end run (below).
- Rewrote README sections: status, supported formats, safety model, troubleshooting, install and packaging, demo steps, and verification status. Updated THIRD_PARTY_NOTICES and this section.

### 13.2 Defects found by the first end-to-end run and how they were resolved

The first run (`/tmp/e2e-run1.log`, process exit 0) reported `identical: false` for one case. Exit 0 did not mean the cases passed. Each cause was investigated before a change was made.

| Case | Symptom | Cause | Fix | Layer |
| --- | --- | --- | --- | --- |
| maven-vuln | Baseline `mvn test` FAIL before any change | Sample set `maven.compiler.release` to 17. The Maven runtime is JDK 21, but `javac` on PATH is JDK 11, and `--release` fails in that setup (`release version 17 not supported`; 11 also failed under `--release`). | Sample uses `maven.compiler.source` and `target` = 11. Baseline and post-change tests pass. | Sample / environment |
| python-vuln | `identical: false` after rollback | Pytest wrote `__pycache__` and `.pytest_cache` into the project. Rollback restores files PatchPilot wrote, so new validation files remained. | Validation runs with `PYTHONDONTWRITEBYTECODE=1` (in `src/upgrade/exec.ts`, applied to every command), and pytest runs with `-p no:cacheprovider` (`src/upgrade/commands.ts`). | PatchPilot |
| harness | Single boolean hid the cause | The restore check combined "modified", "missing", and "extra" files into one result. | Harness reports modified and extra files separately. | Harness |
| npm-repair | Baseline FAIL | Deliberate bug in `src/greet.js` (`"Helo, "`). This is the intended repair case. | Not a defect. Repair fixes it. | Expected |

A note on scope: the Python cause was in PatchPilot, not in the sample. The restore check also cannot distinguish validation outputs from user files. Build outputs such as `target/` and `node_modules/` are still left in place and are documented as a boundary (§13.6).

### 13.3 Commands run and actual results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors. |
| `npm run lint` (`--max-warnings=0`) | Passed, no warnings. |
| `npm run test:unit` | **237 passing, 0 failing.** |
| `DISPLAY=:99 npm test` (compile, unit, Extension Host) | Compile OK. **237 unit passing. 7 Extension Host passing** (VS Code 1.105.0, activation, command registration, key storage, overview, upgrade settings and Plan view, rollback with no plan, status output). Exit 0. |
| `npm audit` | **found 0 vulnerabilities.** |
| `npm run e2e` (second run, after the fixes) | **Exit 0. All four cases: `identical: true`, `rollbackVerified: true`, `validation: validated`** (the npm-repair case: validation failed first, then passed after one repair attempt). Log: `/tmp/e2e-run2.log`. Duration about 150 s, mainly Maven. |
| `npm run package` | **patchpilot.vsix, 229 files, 463.56 KB (474,685 bytes).** Warnings: no `repository` field, no LICENSE file (the project licence is not yet chosen), and the bundling suggestion. |
| VSIX contents | No `samples/`, `scripts/`, `src/`, `.ts` sources, or test files in the package. |
| `code --install-extension patchpilot.vsix` (VS Code 1.105.0 CLI, isolated profile) | Installed. `--list-extensions` shows `patchpilot-dev.patchpilot@0.4.0`. |

Environment: Linux (Debian), Node 20.20.2, npm 10, VS Code 1.105.0, Java runtime 21.0.12 with JDK 11 `javac` on PATH, Maven 3.9.9, pytest 9.0.3, Xvfb on `:99`.

### 13.4 Sample results (live network, real tools)

| Sample | Ecosystem | Finding | Planned change | Validation | Rollback |
| --- | --- | --- | --- | --- | --- |
| `npm-vuln` | npm | `lodash` 4.17.15: 6 OSV advisories. `express` ^4.18.0 is a range and is not edited. | `lodash` to 4.18.1 (0 advisories), `package.json` edit, plus `npm install --package-lock-only` | `npm test` PASS (baseline PASS) | Verified, 3 files byte-identical |
| `npm-repair` | npm | Same finding as npm-vuln. Plus deliberate `"Helo, "` bug. | Same as npm-vuln | Baseline FAIL, validate FAIL, then **repair** (mock model) edits `src/greet.js`, re-validate PASS | Verified, 4 files byte-identical |
| `maven-vuln` | Maven | `commons-lang3` 3.5 (literal `<version>`): 1 OSV advisory. JUnit 4.13.2 is test scope and clean. | `commons-lang3` to 3.21.0, `pom.xml` edit | `mvn -B -q dependency:resolve` PASS, `mvn -B -q test` PASS (baseline PASS) | Verified, 3 files byte-identical |
| `python-vuln` | Python | `requests==2.19.0`: 10 OSV advisories. | `requests` to 2.34.2, `requirements.txt` edit | `pip install --dry-run` PASS, `pytest` PASS (baseline PASS) | Verified, 3 files byte-identical |

Candidate and target choices come from live registries and OSV at run time, so the version numbers can change when advisories are published.

**Repair case, what it does and does not show.** The repair path (request, consent, diff approval, exact-once edit, re-validation, rollback) ran. The model was a local mock OpenAI-compatible endpoint with a fixed reply. The script checked that the key was sent only in the `Authorization` header and was absent from the body, and that the manifest was absent from the body. It is not a test of model quality, and it used no real key.

### 13.5 Verification by area

| Area | Status | Evidence |
| --- | --- | --- |
| Install and launch | **Validated** | VSIX installs in the VS Code 1.105.0 CLI. Activation and command registration are checked by the Extension Host tests on the development build (not on the installed copy). |
| Command discoverability | **Validated (manifest)** | 11 commands, each with a title, all in the Command Palette. No hidden entries. |
| Secrets protection | **Validated (unit and Extension Host)** | Key stored only in secret storage (`modelCommands.test.ts`, Extension Host test). Key not written to log or message. Mock request confirms the key is in the header and not in the body. |
| Untrusted-workspace gating | **Validated (unit)** | `trustGate.test.ts`, `consentAndOverview.test.ts`, `upgradeCommands.test.ts` ("refuses to plan or apply in an untrusted folder"). The gate is not exercised in a real restricted VS Code window. |
| Approval points | **Validated (logic), partially (UI)** | Unit tests cover consent before OSV candidate checks, before model send (declining sends nothing), and the approval flow. The e2e script answers consents automatically and logs them. Modal dialogs were not driven in a real window (see §13.6). |
| Rollback | **Validated** | Each sample: rollback verified, and every original file byte-identical. |

### 13.6 Not covered, and known boundaries

- **Real OpenAI-compatible model.** No key or endpoint is available. Repair was tested only against a mock endpoint.
- **Interactive UI.** The modal consent and diff dialogs were not clicked in a real window. This was also true in Phase 4 (the dialog cannot be reached from the extension-host harness without a test seam, and no production behavior was changed to add one).
- **Build outputs are not tracked.** `mvn` writes `target/`, and npm writes `node_modules/`. Rollback does not remove these, and the restore check ignores them. Users may see them after validation.
- **Lockfile refresh.** The npm lockfile change cannot be previewed, and the approval text says so. The e2e run showed the lockfile restored byte-for-byte.
- **Platforms.** Only Linux was tested. Windows `.cmd` shims and macOS are untested.
- **Maven.** Only direct literal `<version>` pins are edited. Managed and property-derived versions are blocked. Compatibility is not verified (`not verified`).
- **Packaging metadata.** No `repository` field and no LICENSE file. The project licence has not been chosen.
- **Python.** Only `requirements*.txt` `==` pins and PEP 621 `"name==x"` strings are edited.
- **Multi-root workspaces** are refused.
- **Concurrency and large repositories** were not tested.

### 13.7 Source and documentation changes in Phase 5

- `samples/` (new, excluded from VSIX), `scripts/e2e-samples.js` (new, excluded).
- `package.json`: `e2e` script.
- `.vscodeignore`: excludes `samples/**`, `scripts/**`.
- `src/upgrade/exec.ts`: `PYTHONDONTWRITEBYTECODE=1` for validation commands.
- `src/upgrade/commands.ts`: pytest arguments `-p no:cacheprovider`.
- `README.md`, `THIRD_PARTY_NOTICES.md`, `REPORT.md`: updated.
- `patchpilot.vsix`: rebuilt (229 files, 463.56 KB).

### 13.8 Demo steps

1. `npm ci && npm test` (needs `DISPLAY` or `xvfb-run -a` on Linux for the Extension Host tests).
2. `npm run e2e` for the sample workflows on temporary copies.
3. `npm run package` and `code --install-extension patchpilot.vsix`.
4. Open a copy of `samples/npm-vuln` as a trusted folder. Run **Analyze Dependencies**, **Plan Upgrade**, **Review and Apply Plan**, **Validate Changes**, and **Roll Back Changes**.

### 13.9 Phase 5 approval request

Phase 5 was approved by the user on 2026-10-12. Open items carried forward: real-model repair, interactive modal checks, Windows and macOS testing, and the license choice.

