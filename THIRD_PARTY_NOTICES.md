# Third-Party Notices

Last updated: 2026-10-12 (Phase 5)

## 1. Reused or adapted code

**No third-party source code has been copied into PatchPilot in Phases 1–5.** No OpenCode source file has been copied. The OpenAI-compatible client, SSE parser, redaction, and endpoint validation in `src/ai/` and `src/security/` were written for PatchPilot from the public Chat Completions and Server-Sent Events behavior. They do not derive from OpenCode code.

### Reference-only review of OpenCode (not copied)

| Item | Upstream | Commit | License | Decision |
| --- | --- | --- | --- | --- |
| OpenCode repository | https://github.com/sst/opencode | `e41e7e9064f1cb380f0905dd19c611756a577e79` (main, cloned 2026-10-12) | MIT (`LICENSE`, "Copyright (c) 2025 opencode") | Read-only reference. Repository left unmodified (`git status` clean). |
| `packages/ai/src/providers/openai-compatible.ts` and `packages/ai/src/protocols/` | same | same | MIT (`packages/ai/package.json`) | **Not copied.** The implementation is a thin wrapper over OpenCode's internal route, schema, and Effect-based runtime. PatchPilot uses a small, fetch-based OpenAI-compatible Chat Completions client written from the public API contract instead. |
| `packages/ai/src/protocols/utils/partial-json.ts` and `partial-json-options.ts` | Adapted from `promplate/partial-json-parser-js` (Promplate Dev Team, MIT, Copyright (c) 2023) | same | MIT with the file-level notice retained upstream | **Not copied.** PatchPilot does not need partial-JSON streaming in the planned scope. If that changes, the file-level MIT notice must be retained verbatim in any copy. |

## 2. Runtime dependencies

PatchPilot ships three runtime dependencies. They are bundled in the packaged VSIX through `node_modules`, and each is used without modification.

| Package | Version | License | Used for | Upstream |
| --- | --- | --- | --- | --- |
| `fast-xml-parser` | 5.11.2 | MIT (`LICENSE`, Copyright (c) 2017 Amit Kumar Gupta) | Parsing `pom.xml` and Maven `maven-metadata.xml` | https://github.com/NaturalIntelligence/fast-xml-parser |
| `smol-toml` | 1.9.1 | BSD-3-Clause (`LICENSE`, Copyright (c) Squirrel Chat et al.) | Parsing `pyproject.toml` | https://github.com/squirrelchat/smol-toml |
| `semver` | 7.8.5 | ISC (`LICENSE`, Copyright (c) Isaac Z. Schlueter and Contributors) | npm version parsing, comparison, and range matching | https://github.com/npm/node-semver |

Compile-time only: `@types/semver` 7.8.0 (MIT, DefinitelyTyped), dev dependency, not shipped.

The VSIX contains PatchPilot's compiled JavaScript plus these packages. Every other dependency is development-only and is not shipped.

## 3. Development dependencies (not shipped)

Checked from `node_modules/*/package.json` on 2026-10-12. Development-only tools are not included in the VSIX.

| License | Count | Notes |
| --- | --- | --- |
| MIT | 211 | |
| ISC | 19 | |
| Apache-2.0 | 16 | |
| BSD-2-Clause | 9 | |
| BSD-3-Clause | 5 | |
| BlueOak-1.0.0 | 6 | |
| Artistic-2.0 | 5 | `binaryextensions`, `editions`, `istextorbinary`, `textextensions`, `version-range` (transitive, used by `@vscode/vsce`). Dev-only. |
| (MIT OR GPL-3.0-or-later) | 1 | `jszip`, dev-only; PatchPilot uses it under the MIT option. |
| (MIT AND Zlib) | 1 | `pako`, dev-only. |
| Python-2.0 | 1 | |
| 0BSD | 1 | |
| SEE LICENSE IN LICENSE.txt | 2 | `@vscode/vsce-sign` and its linux-x64 binary (Microsoft, dev-only packaging signing helper). Review before any redistribution of tooling. |

Direct development dependencies: `@types/mocha`, `@types/node`, `@types/vscode`, `@vscode/test-electron`, `@vscode/vsce` (4.0.0), `eslint`, `mocha` (12.x), `typescript`, `typescript-eslint`.

The VS Code build used by the extension-host test (1.105.0) is downloaded from Microsoft at test time and is governed by Microsoft's license terms. It is not redistributed.

## 4. Test fixtures and samples

- `samples/` and `scripts/e2e-samples.js` are PatchPilot's own code. The sample projects use public packages (`lodash` 4.17.15, `express`, `commons-lang3` 3.5, JUnit 4.13.2, `requests` 2.19.0) only as vulnerable or outdated examples. Nothing from those packages is copied into PatchPilot, and the samples are not packaged in the VSIX. They are installed into temporary copies during `npm run e2e`.
- Tools used only for end-to-end runs and not shipped: Apache Maven 3.9.9, pytest 9.0.3, and Xvfb in the development sandbox. PatchPilot runs `python -m pip install --dry-run` for Python validation, which installs nothing.
- Live data sources used at run time, under their own terms: npm registry (`registry.npmjs.org`), Maven Central, PyPI, and OSV (`api.osv.dev`). Responses are not stored in the repository. Licence terms for the data were not reviewed in Phase 5.
