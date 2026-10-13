<div align="center">

<img src="assets/AIHT_LOGO-removedbg.png" alt="AIHT logo" width="120"/>

# PatchPilot

### Dependency Intelligence and Controlled Repair for VS Code

**Anand Institute of Higher Technology (AIHT) - An Autonomous Institute**
**Kazhipattur, Chennai**

---

*A TypeScript extension that finds known vulnerabilities in your npm, Maven, and
Python dependencies, plans a reviewed upgrade, validates the result with your
own test commands - and never touches a manifest without showing you the diff
first.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.105%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Mocha](https://img.shields.io/badge/tests-Mocha-8B4E20?logo=mocha&logoColor=white)](https://mochajs.org/)
[![ESLint](https://img.shields.io/badge/lint-ESLint-4B32C3?logo=eslint&logoColor=white)](https://eslint.org/)
[![License: Unlicensed](https://img.shields.io/badge/License-UNLICENSED-red.svg)](#18-license)

</div>

---

<div align="center">

### Scope of this repository

| Component | Where it lives | Role |
|---|---|---|
| **Analysis** | `src/analysis/`, `src/ecosystems/` | Parses manifests, reads lockfiles, decides vulnerability and freshness |
| **Evidence** | `src/registry/`, `src/advisories/` | Fetches npm, Maven Central, PyPI and OSV metadata |
| **Workflow** | `src/upgrade/` | Plans, applies, validates, repairs, rolls back |
| **AI** | `src/ai/` | One narrowly scoped job: propose source edits after a failure |

This repository contains the **entire extension**. There is no separate backend,
no companion service and no cloud component.

</div>

---

## Table of Contents

1. [Project at a Glance](#1-project-at-a-glance)
2. [Screens](#2-screens)
3. [Repository Layout](#3-repository-layout)
4. [Author and Project Context](#4-author-and-project-context)
5. [Motivation and Problem Statement](#5-motivation-and-problem-statement)
6. [Extension Architecture](#6-extension-architecture)
7. [Technical Background](#7-technical-background)
8. [The Upgrade Path](#8-the-upgrade-path)
9. [Safety and Privacy Guarantees](#9-safety-and-privacy-guarantees)
10. [Installation and Build](#10-installation-and-build)
11. [Running in VS Code](#11-running-in-vs-code)
12. [Configuration](#12-configuration)
13. [Commands](#13-commands)
14. [Testing](#14-testing)
15. [Codebase Metrics](#15-codebase-metrics)
16. [Limitations and Future Work](#16-limitations-and-future-work)
17. [Acknowledgements](#17-acknowledgements)
18. [License](#18-license)

---

## 1. Project at a Glance

A vulnerable dependency is not a problem you can solve by reading a scanner's
web page. It is a problem that ends in **a version string in a file that
something else is watching**, and every tool that offers to fix it for you is
ultimately asking you to trust an automated decision with your build.

PatchPilot is built around refusing that trade. It does the deterministic work
itself, shows you every byte it intends to change, and asks before each one.

What it does:

- **Reads** `package.json` (with `package-lock.json` v1/v2/v3), `pom.xml`,
  `requirements*.txt` and PEP 621 `pyproject.toml`.
- **Reports** known OSV advisories, outdated versions, npm deprecations, and the
  source and timestamp behind every finding. A lookup that failed is shown as
  **unavailable**, never as clean.
- **Plans** an upgrade for each vulnerable or deprecated **exact pin**, choosing
  the newest stable candidate that carries zero advisories.
- **Shows a diff** for every file it intends to write, then asks for one
  approval covering the whole edit set.
- **Snapshots** every file before writing it, so rollback restores byte-identical
  content verified by hash.
- **Validates** by running your own commands - `npm test`, `mvn -B -q test`,
  `pytest`, and three more - with no shell, capped output and a timeout.
- **Optionally asks a model** to repair source code when validation fails, and
  only ever after you approve each individual send and each individual diff.
- **Rolls back** on request, leaving alone any file you changed yourself.

> **The model is not in charge of versions.** PatchPilot never asks an LLM to
> choose a dependency version, judge an advisory, or decide whether a build
> passed. The model has exactly one job: your tests failed, here is the output,
> propose a fix to the source. Every version decision is computed, and every one
> of them is shown to you before it is written.

---

## 2. Screens

All screenshots are captured from a running **Extension Development Host** against
the bundled sample projects.

<div align="center">

| Vulnerabilities detected in `package.json` | Review the plan and approve |
|:---:|:---:|
| <img src="assets/Detected.png" width="420"/> | <img src="assets/Review_apply_plan.png" width="420"/> |

</div>

<div align="center">

| Consent before anything is sent to the model | Approve the model-proposed repair |
|:---:|:---:|
| <img src="assets/Repair_with_model.png" width="420"/> | <img src="assets/accept_change_2.png" width="420"/> |

</div>

<div align="center">

| Model-proposed edit to the test file | After repair: advisories cleared |
|:---:|:---:|
| <img src="assets/accept_change_1.png" width="420"/> | <img src="assets/final_with_vulnerability.png" width="420"/> |

</div>

Two details in these screenshots are the whole design in miniature:

1. The **apply dialog** states *"Compatibility of target versions is NOT verified
   by PatchPilot"* in the same breath as the change list. PatchPilot will not let
   you read a plan without also reading its limits.
2. The **model consent dialog** names the endpoint, the receiving host, the model,
   the exact files being sent, and the active exclusion patterns - *before* the
   request, every time.

---

## 3. Repository Layout

```text
PatchPilot/
|-- README.md                      <- You are here
|-- REPORT.md                      <- Phase plan, design decisions, verification log
|-- THIRD_PARTY_NOTICES.md         <- Third-party provenance and licences
|-- package.json                   <- Manifest, commands, settings, view contributions
|-- package-lock.json
|-- tsconfig.json                  <- Strict TypeScript configuration
|-- eslint.config.mjs              <- Type-checked ESLint rules
|-- .vscodeignore                  <- Keeps sources and tests out of the VSIX
|-- .vscode/                       <- launch.json (F5) and tasks.json
|-- patchpilot.vsix                <- Built package
|
|-- assets/                        <- Institute logo and screenshots
|-- samples/                       <- Four runnable demo projects
|   |-- npm-vuln/                  <- lodash 4.17.15 (known advisory)
|   |-- npm-repair/                <- Deliberate bug for the repair loop
|   |-- python-vuln/               <- requests==2.19.0
|   `-- maven-vuln/                <- Vulnerable Maven coordinate
|-- scripts/e2e-samples.js         <- Headless end-to-end runner
|-- test-fixtures/
|
`-- src/
    |-- extension.ts               <- Activation, command registration, view wiring
    |-- log.ts                     <- Redacting logger
    |-- workspaceStatus.ts         <- Trust and folder status report
    |
    |-- analysis/                   <- Types, manifest detection, runner, assessment rules
    |   |-- types.ts               |-- assess.ts  |-- runner.ts  |-- detect.ts
    |   |-- versions.ts            |-- clients.ts |-- consent.ts
    |-- ecosystems/                <- Manifest parsers
    |   |-- npm.ts  |-- maven.ts  `-- pypi.ts
    |-- registry/                  <- Registry clients and a bounded HTTP helper
    |   |-- http.ts  |-- npm.ts  |-- maven.ts  `-- pypi.ts
    |-- advisories/osv.ts          <- OSV batch query and advisory lookup
    |-- upgrade/                   <- The repair workflow
    |   |-- planner.ts             |-- targets.ts   |-- edits.ts
    |   |-- workflow.ts            |-- commands.ts   |-- exec.ts
    |   |-- store.ts               |-- repair.ts    |-- types.ts
    |   `-- planSummary.ts
    |-- commands/                  <- Command flows with UI and runners injected
    |   |-- analyzeCommand.ts  |-- upgradeCommands.ts  `-- modelCommands.ts
    |-- ai/                        <- OpenAI-compatible client, SSE parser, validation
    |   |-- openaiCompatible.ts  |-- sse.ts  |-- endpoint.ts  |-- types.ts
    |-- ui/                        <- Views and their pure models
    |   |-- workflowModel.ts     |-- workflowView.ts
    |   |-- overviewModel.ts     |-- overviewView.ts
    |   |-- dependencyModel.ts   |-- dependencyView.ts
    |   |-- planModel.ts         |-- planView.ts
    |   |-- vscodeModelUi.ts     |-- vscodeUpgradeUi.ts
    |   |-- consentText.ts       |-- diffPreview.ts
    |-- config/                    <- Validated settings limits
    |-- secrets/apiKeyStore.ts     <- VS Code secret storage
    |-- security/                  <- Secret redaction and context exclusions
    |-- workspace/trustGate.ts     <- Workspace Trust policy
    `-- test/
        |-- runTest.ts
        |-- suite/                 <- Extension Host smoke tests
        `-- unit/                  <- Pure unit tests, no VS Code and no network
```

The `*Model.ts` / `*View.ts` split is deliberate: **models are pure functions**
with no `vscode` import, so they can be unit tested directly, while **views** are
thin adapters that only translate a model into a `TreeItem`.

---

## 4. Author and Project Context

| Field | Value |
|---|---|
| **Author** | Sivaprakash J |
| **Roll Number** | 310123104093 |
| **GitHub** | [CoreCoderX](https://github.com/CoreCoderX) |
| **College** | Anand Institute of Higher Technology (AIHT) - An Autonomous Institute |
| **Location** | Kazhipattur, Chennai |
| **Degree** | B.E. Computer Science & Engineering |
| **Department** | Computer Science & Engineering |
| **Academic Year** | 2023 - 2027 |
| **Supervisor** | Mrs. Tamil Arasi, Department of CSE, AIHT |

---

## 5. Motivation and Problem Statement

Almost every dependency vulnerability alert resolves into the same three
questions, and existing tools answer them badly:

1. **Is this actually a problem for *my* project?** A scanner reports a CVE in a
   transitive package you never call. The signal-to-noise ratio is poor enough
   that teams learn to ignore the tool.
2. **Which version fixes it?** Often answered with a range, or with "latest",
   or with a major bump that breaks every call site in your code.
3. **Will the fix break me?** Almost never answered at all.

The dangerous part is the last one. The honest answer - *we do not know until you
run your own tests* - is also the least useful thing an automated tool can say.
So tools compensate by doing something worse: they change the version, and if the
build goes red you are left debugging a diff you did not write and did not
understand.

PatchPilot's position is that **the version bump is the cheap part and the code
change is the expensive part**, and a tool that only handles the cheap part while
implying it handled both is actively misleading.

So the design answers a narrower question than "can a tool upgrade my
dependencies":

> **Can a tool propose a dependency change, prove exactly what it changed, let
> the project's own test suite judge the consequence, and hand the source back
> unchanged if that judgement fails?**

Everything below follows from that question. The model cannot pick versions,
because a model picking versions cannot be audited. The model cannot edit
manifests, because a model that can downgrade a library is a supply-chain hole.
And every write is preceded by a diff and a snapshot, because the only honest
posture toward an automated edit is *reversible*.

---

## 6. Extension Architecture

```text
+------------------------------------------------------------------------------+
|  Workflow view            Every command as a clickable row, in order          |
|  Overview / Dependencies / Plan                                              |
+---------------------------------+--------------------------------------------+
                                  |  user clicks a row, or uses the Command Palette
                                  v
+------------------------------------------------------------------------------+
|  commands/     analyzeCommand | upgradeCommands | modelCommands              |
|  - trust gate first                                                                |
|  - consent prompt before any network or model send                             |
|  - UI and runners injected, so every flow is testable without a UI              |
+---------------------------------+--------------------------------------------+
                                  |
        +-------------------------+-------------------------+
        v                         v                         v
+--------------------+  +--------------------+  +--------------------+
| analysis/ +        |  | upgrade/           |  | ai/                 |
| ecosystems/        |  |  planner  -> plan  |  |  OpenAI-compatible  |
|  parse manifests   |  |  edits    -> diffs  |  |  client + SSE       |
|  read lockfiles    |  |  store    -> snaps |  |  consent per send   |
|  assess versions   |  |  exec     -> cmds  |  +--------------------+
+---------+----------+  +--------------------+
          |
          v
+------------------------------------------------------------------------------+
|  registry/ + advisories/    registry.npmjs.org, repo1.maven.org,              |
|                              pypi.org, api.osv.dev                            |
|  - names and versions only; no file contents, no paths, no credentials       |
+------------------------------------------------------------------------------+
```

### Layering

| Layer | Location | Responsibility |
|---|---|---|
| Composition | `extension.ts` | Activation, command registration, view wiring, refresh triggers |
| UI | `ui/`, `commands/` | Tree views, prompts, diff preview, progress |
| Domain | `analysis/`, `upgrade/` | All decisions: versions, advisories, plans, edits |
| I/O | `registry/`, `advisories/`, `ai/` | Network clients, all bounded and timeout-capped |
| Policy | `workspace/`, `security/`, `secrets/` | Trust gate, redaction, exclusions, key storage |

There is no dependency-injection framework and no global mutable state beyond the
three values the views need (`lastResult`, `latestRecord`, `lastTest`). Each
command receives its collaborators as an explicit deps object, which is why 252
unit tests can drive the entire workflow without launching VS Code.

---

## 7. Technical Background

### 7.1 Manifest parsing without a package manager

PatchPilot never runs `npm install` to find out what you depend on. It parses
`package.json`, `package-lock.json` (v1, v2 and v3), `pom.xml` and
`requirements*.txt` itself, using `fast-xml-parser` for XML and `smol-toml` for
TOML.

The reason is safety. Resolving a dependency tree requires executing the
package manager, which means executing the project's scripts. An extension whose
entire purpose is "safely handle untrusted dependencies" cannot open by running
arbitrary code from the folder it is trying to help with.

Parsing also lets PatchPilot distinguish things a resolver flattens. Each
dependency is classified as `exact`, `range`, `unpinned`, `managed` or
`unresolved`, and **only exact pins are ever upgraded**. A caret range or a
BOM-inherited Maven version is reported as *blocked*, never edited.

### 7.2 OSV as the advisory source

Advisories come from [OSV](https://osv.dev/), which indexes advisories in an
open schema across ecosystems. PatchPilot sends a **batch query** containing only
package names and version strings.

Two properties matter for the user experience:

- A lookup that fails is reported as `unavailable`, and the affected source is
  shown as unavailable. A network error is never rendered as "no known
  advisories", because that would turn a transient outage into a false all-clear.
- Every finding carries **evidence**: the source URL, the query time, and the
  reason it was raised. The Dependencies view renders that tree so a finding can
  be traced back to its source.

### 7.3 Candidate selection

For each vulnerable or deprecated exact pin, PatchPilot collects the top
`MAX_TARGET_CANDIDATES` (**5**) newer stable versions and checks each against
OSV. It picks the newest one with zero advisories.

Five is deliberate: it is enough to skip a recently patched release, and small
enough that the consent prompt can state the exact number of queries before you
approve them.

### 7.4 Bounding what a model can see

Three limits apply before anything is sent, independent of the exclusion
patterns:

| Limit | Value | Location |
|---|---:|---|
| Source files per repair attempt | **8** | `MAX_CANDIDATE_FILES` |
| Bytes per file | **60,000** | `MAX_CANDIDATE_BYTES` |
| Total bytes per attempt | **120,000** | `MAX_TOTAL_BYTES` |

Files are *selected* rather than dumped: first by filename appearing in the
failing command's output, and failing that by the file mentioning one of the
upgraded dependency names. An unrelated file that happens to be in the project
is not sent.

### 7.5 The `never-editable` boundary

This is the single most important piece of the AI path, in `src/upgrade/repair.ts`:

```ts
const NEVER_EDITABLE = /(^|\/)(package\.json|package-lock\.json|pom\.xml| ... )$/i;
```

Three rules constrain what a model may ever do:

| Rule | Implementation | Why |
|---|---|---|
| **Never touch a manifest** | `NEVER_EDITABLE` regex | A model that can edit `package.json` can silently revert a vulnerability fix |
| **Only allowlisted files** | `parseRepairReply` rejects any path not supplied | The model cannot invent a target |
| **Exact-once edits** | `applyRepairEdits` requires `search` to occur exactly once | Prevents sweeping rewrites and ambiguous matches |

The prompt additionally states that command output and file contents are **data,
not instructions**, which is the standard mitigation for prompt injection through
a toolchain that writes attacker-controlled text into error messages.

### 7.6 Running commands without a shell

Validation uses a fixed template table. There is no command string, no user
input, and `shell: false`. The only shell involvement anywhere is the Windows
`.cmd` shim resolution for `npm.cmd` and `mvn.cmd`, whose arguments are still
drawn from the fixed table.

```text
npm-lock-refresh          npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm-test                  npm test
npm-build                 npm run build
maven-dependency-resolve  mvn -B -q dependency:resolve
maven-test                mvn -B -q test
pypi-pip-dry-run          python -m pip install --dry-run --quiet -r <file>
pypi-pytest               python -m pytest -q -p no:cacheprovider
```

Python is invoked as `python -m ...` rather than as a bare `pytest` or `pip`, so
the command uses the same interpreter that PatchPilot resolves rather than
whatever happens to be first on `PATH`.

`--ignore-scripts` on the lockfile refresh is what keeps the npm path from
becoming an arbitrary-code-execution vector, and `-p no:cacheprovider` stops
`pytest` writing a cache directory into your project.

### 7.7 Snapshot and rollback

Every write is preceded by `SnapshotStore.beginStep`, which copies the current
content of each file and records its SHA-256. On rollback, each file is restored
and its hash re-checked.

The interesting case is a file you edited *after* PatchPilot wrote it. Rollback
compares the current hash against the recorded `afterHash`; if they differ, the
file is reported as a **conflict** and left alone. An automated tool that
clobbered your follow-up work would be worse than no tool.

---

## 8. The Upgrade Path

```text
  Analyze Dependencies
    read manifests + lockfiles          (local, no network)
    ask consent
    query OSV + registries              (names and versions only)
    render Dependencies view
         |
         v
  Plan Upgrade
    reuse last analysis, or run one
    collect top-5 newer stable candidates per vulnerable/deprecated pin
    ask consent
    check candidates against OSV
    refuse anything that is not an exact pin
    render Plan view                    (changes nothing)
         |
         v
  Review and Apply Plan
    open a diff per changed file
    ONE approval listing every file and every command line
    refuse if any file changed since the plan was made
    snapshot -> write
         |
         v
  Validate Changes                      (one consent per plan)
    run the plan's fixed commands
    cap output, redact secrets, enforce timeout
    record pass/fail per command
         |
    +----+-------------------------+----------------+
    |                              |                |
    v                              v                v
  pass                        fail                apply failed
    |                              |                |
    |                        Repair with Model        |
    |                          ask consent per send    |
    |                          send failing output     |
    |                            + source files        |
    |                          model returns JSON edits|
    |                          strict parse           |
    |                          diff -> approve         |
    |                          snapshot -> write       |
    |                          re-run validation       |
    |                          stop on repeat failure  |
    v                              |                |
  done <---------------------------+----------------+
                                     |
                                     v
                            Roll Back Changes
                            confirm the exact file list
                            restore from snapshot
                            verify every hash
                            report conflicts, leave them alone
```

The path is a **chain of gates, not an agent loop**. Each step can only be
reached by satisfying the previous one, and `upgradeCommands.ts` refuses to
advance when the precondition does not hold - for example, `repairWithModel`
checks `status === "applied" || status === "validation-failed"` and returns
`"nothing"` otherwise.

---

## 9. Safety and Privacy Guarantees

| Guarantee | How it is enforced |
|---|---|
| No code runs at activation | No command executes until you click one |
| No package manager runs during analysis | Manifests are parsed, never resolved |
| Trust required to touch files | `gateModelAction` and `guard` block untrusted folders |
| Consent before every network request | `buildAnalysisConsent` states endpoints and counts |
| Consent before every model send | `buildConsentMessage` names host, model, and files |
| The model never picks a version | No model call exists in `planner.ts` |
| The model never edits a manifest | `NEVER_EDITABLE` regex in `repair.ts` |
| Model edits must match exactly once | `applyRepairEdits` occurrence check |
| One approval covers the whole edit set | `describePlanForReview` then a single confirm |
| Snapshots before every write | `SnapshotStore.beginStep` |
| Rollback verifies hashes | `SnapshotStore.rollback` refuses unverified restores |
| Fixed commands, no shell | Template table, `shell: false`, `--ignore-scripts` |
| Key in secret storage only | `context.secrets`, never settings or files |
| Endpoint cannot be redirected by a project | `baseUrl`/`model` are **application** scope |
| No telemetry, no backend | None exists in the codebase |

### What leaves your machine

| Destination | Data sent | Carries a key? |
|---|---|---|
| `registry.npmjs.org` | package name | No |
| `repo1.maven.org/maven2` | Maven coordinates | No |
| `pypi.org` | package name | No |
| `api.osv.dev` | package name + version | No |
| Your configured model endpoint | failing command, redacted output, approved source files | Yes - `Authorization` header only |

Your key is sent **only** in the `Authorization` header to the endpoint you
configured. It never appears in prompt content, logs or error text, and error
messages are redacted before display.

---

## 10. Installation and Build

### 10.1 Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** | 20 or later |
| **npm** | 10 or later |
| **VS Code** | 1.105 or later |
| **Python** | Only to run the Python samples and `pytest` validation |
| **JDK + Maven** | Only for the Maven samples |

### 10.2 Install and build

```powershell
npm ci
npm run package
code --install-extension patchpilot.vsix
```

The packaged extension is **231 files, about 469 KB**. `.vscodeignore` keeps
`src/`, `samples/`, `scripts/`, tests and the report out of the VSIX.

### 10.3 Scripts

| Script | What it does |
|---|---|
| `npm run compile` | `tsc -p ./` |
| `npm run typecheck` | Strict type check, no emit |
| `npm run lint` | ESLint with type-checked rules, `--max-warnings=0` |
| `npm run test:unit` | 252 unit tests - no VS Code, no network, no credentials |
| `npm run test:extension` | 9 Extension Host tests (downloads VS Code on first run) |
| `npm test` | compile + unit + extension tests |
| `npm run package` | Builds `patchpilot.vsix` |
| `npm run e2e` | Runs the sample projects headlessly (network required) |

### 10.4 Security posture of the toolchain

```powershell
npm audit
# found 0 vulnerabilities
```

Runtime dependencies are deliberately minimal - **`fast-xml-parser`**, **`semver`**
and **`smol-toml`** - because every added dependency is code that runs inside a
security tool.

---

## 11. Running in VS Code

### 11.1 Development

Open the folder in VS Code and press **F5** (*Run PatchPilot Extension*). A
second window opens with the extension loaded; a sample project is already
opened in it.

Or from a terminal:

```powershell
code --extensionDevelopmentPath="$PWD" --new-window "$PWD\samples\npm-vuln"
```

### 11.2 Trust the folder

PatchPilot shows trust state in the Overview view. Analysis, planning, apply,
validation and repair all require a **trusted** folder. In restricted mode only
key management and the connection test remain available.

### 11.3 The guided run

1. Click the **PatchPilot** icon in the activity bar.
2. In **Workflow**, click **Analyze Dependencies** and confirm. Results appear
   in **Dependencies**.
3. Click **Plan Upgrade** and confirm. The plan appears in **Plan**.
4. Click **Review and Apply Plan**. Read the diff, then approve once.
5. Click **Validate Changes** and approve once.
6. Click **Repair with Model** if validation failed, or **Roll Back Changes**.

Every step is a click. A step you cannot run yet tells you why, and is still
clickable so the command can explain it in full.

### 11.4 Trying the repair loop

`samples/npm-repair/` contains a deliberate bug in `src/greet.js`. Running apply
then validate produces a failure, and **Repair with Model** can propose the fix -
if you have configured an endpoint and a key.

### 11.5 Headless end-to-end

```powershell
npm run e2e
```

Runs the workflows against copies of `samples/` in a temp folder, using a local
mock model endpoint. Requires network access.

---

## 12. Configuration

| Setting | Default | Scope | Notes |
|---|---|---|---|
| `patchpilot.ai.baseUrl` | `https://api.openai.com/v1` | **application** | `https`, or `http` only for `localhost`/`127.0.0.1`/`[::1]` |
| `patchpilot.ai.model` | *(empty)* | **application** | Required before any model action |
| `patchpilot.ai.timeoutSeconds` | `60` | **application** | 5-300. Total time for one request |
| `patchpilot.context.excludePatterns` | `[]` | window | Extra globs never sent to a model |
| `patchpilot.upgrade.commandTimeoutSeconds` | `300` | window | 10-3600. Per-command timeout |
| `patchpilot.upgrade.repairMaxIterations` | `2` | window | 1-5. Model repair attempts |

`baseUrl` and `model` are **application (user) scope** on purpose. A cloned
repository containing `.vscode/settings.json` cannot redirect your API key to an
attacker's endpoint.

Built-in secret-file patterns (`.env*`, `*.pem`, `*.key`, and others) always
apply and cannot be removed through settings.

---

## 13. Commands

Every command is available as a clickable row in the **Workflow** view. The
Command Palette entries still exist and run exactly the same handlers.

| Command | What it does |
|---|---|
| **Analyze Dependencies** | Reads manifests locally, asks consent, then queries registries and OSV. Read-only. |
| **Plan Upgrade** | Builds a plan from the last analysis. Asks consent before OSV candidate checks. Changes nothing. |
| **Review and Apply Plan** | Opens diffs, asks one approval, then writes. Snapshots first. |
| **Validate Changes** | Runs the plan's fixed commands after one approval per plan. |
| **Repair with Model** | After a failed validation, asks the model for exact-once source edits. |
| **Roll Back Changes** | Restores files from snapshots and verifies every hash. |
| **Show Workspace Status** | Writes trust state and open folders to the output channel. |
| **Set Model API Key** | Stores the key in VS Code secret storage. |
| **Clear Model API Key** | Removes the stored key after confirmation. |
| **Test Model Connection** | Sends one fixed sentence after consent. No workspace content. |
| **Open Model Settings** | Opens the `patchpilot` settings. |

### Supported formats

| Ecosystem | Analysis | Upgradeable |
|---|---|---|
| **npm** | `package.json` + `package-lock.json` v1/v2/v3 | Exact pins only |
| **Maven** | `pom.xml` direct dependencies | Literal `<version>` only; property-derived and BOM-managed are **blocked** |
| **Python** | `requirements*.txt` (`==`), PEP 621 `pyproject.toml` | `name==x.y.z` strings only |

**Not supported:** `yarn.lock`, `pnpm-lock.yaml`, Gradle, Pipenv, `setup.py`,
Poetry tables, `-r` includes, multi-root workspaces, and transitive dependency
analysis.

---

## 14. Testing

```powershell
npm test
```

| Suite | Count | Needs |
|---|---:|---|
| Unit (`mocha`) | **252** | Nothing - no VS Code, no network, no credentials |
| Extension Host | **9** | VS Code 1.105 (downloaded on first run) |

The unit suite is large relative to the codebase because the architecture is
built for it: every command flow takes its UI, clock, logger and network client as
injected dependencies, so the full plan/apply/validate/repair/rollback cycle is
exercised in-process.

On Linux without a display:

```bash
xvfb-run -a npm test
```

### What the tests actually assert

- The apply refuses when a file changed after the plan was built.
- Rollback restores byte-identical content and reports conflicts rather than
  clobbering.
- No network request is made before consent is granted - verified by counting
  calls on the injected client.
- The model repair loop sends nothing when consent is declined.
- `NEVER_EDITABLE` rejects every manifest and lockfile path.
- View models never contain the API key.
- Every contributed command is registered *and* reachable from the Workflow view.

---

## 15. Codebase Metrics

| Module | Lines |
|---|---:|
| `upgrade/` | 1,612 |
| `analysis/` | 1,134 |
| `ui/` | 1,017 |
| `commands/` | 575 |
| `ecosystems/` | 534 |
| `extension.ts`, `log.ts`, `workspaceStatus.ts` | 447 |
| `ai/` | 425 |
| `registry/` | 389 |
| `advisories/` | 153 |
| `security/` | 93 |
| `config/` | 88 |
| `secrets/` | 61 |
| `workspace/` | 20 |
| **Production total** | **6,548** |
| Tests | 3,247 |
| **Total** | **9,795** |

| Parameter | Value |
|---|---|
| Language | TypeScript 5.9, `strict` |
| Host | VS Code `^1.105.0` |
| Runtime | Node 20+ |
| Runtime dependencies | `fast-xml-parser`, `semver`, `smol-toml` |
| Test runner | Mocha 12 + `@vscode/test-electron` |
| Lint | ESLint 9, `typescript-eslint` `strictTypeChecked` |
| Extension version | 0.4.0 |
| Package | 231 files, ~469 KB |

---

## 16. Limitations and Future Work

### 16.1 Known limitations

These are stated plainly because a security tool that overstates its coverage is
worse than one that admits its edges.

- **Compatibility is not verified.** Every plan item carries the literal string
  `"Compatibility not verified."` PatchPilot does **not** statically check whether
  a new version breaks your call sites. `assess.ts` hardcodes compatibility as
  `unknown`.
- **Major-version bumps are not flagged.** Candidate selection is "newest stable
  with zero advisories". A jump from `4.x` to `5.x` is not marked as breaking.
  Only your test suite will catch it.
- **Validation is only as good as your tests.** A project with no real test
  script will "pass" validation after any bump, including a breaking one.
- **Transitive dependencies are not analysed.** Only direct dependencies are
  checked.
- **Results are not cached.** Every run re-queries the services.
- **Maven versions are literal-only.** Property-derived and BOM-managed versions
  are reported as blocked, never resolved. There is no `mvn dependency:tree`.
- **Multi-root workspaces are refused** for upgrades.
- **Not validated on Windows or macOS.** End-to-end verification was carried out
  on Linux; the Extension Host tests do run on Windows.
- **Rollback restores files, not build output.** `target/`, `__pycache__/` and
  similar are not tracked and not removed.

### 16.2 Planned extensions

1. **Static compatibility checking** - scan call sites of changed APIs between
   the locked and target version. This is the largest real gap and needs a
   per-language resolver rather than a heuristic.
2. **Major-version detection** - mark a candidate as breaking when the semver
   major differs, and require an explicit acknowledgement.
3. **`yarn.lock` and `pnpm-lock.yaml` support** - the parsers are per-ecosystem,
   so the shape is already right.
4. **Maven `dependency:tree` resolution** - opt-in, trusted folder only, to
   resolve BOM-managed versions instead of blocking them.
5. **Transitive advisory reporting** - distinct from transitive *analysis*, to
   avoid a second false-all-clear failure mode.
6. **Analysis result caching** - with an explicit staleness indicator.

---

## 17. Acknowledgements

- **Mrs. Tamil Arasi**, Department of Computer Science & Engineering, AIHT, for
  guidance and technical feedback throughout this project.
- **Anand Institute of Higher Technology (AIHT)**, Kazhipattur, for the academic
  environment this project was carried out in.
- **[OSV](https://osv.dev/)** and its contributors, for an open advisory schema
  that spans ecosystems and needs no vendor key.
- **[VS Code](https://code.visualstudio.com/)** for the extension host, the
  secret storage API and the diff editor that every approval is presented in.
- **[TypeScript](https://www.typescriptlang.org/)**, **[ESLint](https://eslint.org/)**
  and **[Mocha](https://mochajs.org/)** - the maintainers of the toolchain this
  project is written and tested against.
- The maintainers of **`fast-xml-parser`**, **`semver`** and **`smol-toml`**, the
  three runtime dependencies. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## 18. License

**No licence has been selected yet.** `package.json` is marked
`"license": "UNLICENSED"` and `"private": true`, so the code is **not** currently
redistributable and no `LICENSE` file exists in this repository.

Choose a licence before publishing. Until then, treat the source as private.

Third-party dependencies keep their own licences regardless of what is chosen
here; provenance is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">

---

*PatchPilot - dependency intelligence and controlled repair for VS Code*
*B.E. Computer Science & Engineering - AIHT, Kazhipattur, Chennai - 2023 - 2027*
*Supervised by Mrs. Tamil Arasi, Department of CSE*

[github.com/CoreCoderX/PatchPilot](https://github.com/CoreCoderX/PatchPilot)

</div>