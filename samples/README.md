# Sample projects

Small projects used for end-to-end checks of PatchPilot. They are not packaged in the VSIX.

| Sample | Ecosystem | Purpose |
| --- | --- | --- |
| `npm-vuln/` | npm | `lodash` 4.17.15 (vulnerable, exact pin), `express` as a range (not edited). Test script runs `node test.js`. |
| `npm-repair/` | npm | Same dependency, plus a deliberate bug in `src/greet.js` that fails validation. Used for the repair demonstration. |
| `maven-vuln/` | Maven | `commons-lang3` 3.5 (vulnerable, literal `<version>`), JUnit 4 test scope. Test runs `mvn -B -q test`. |
| `python-vuln/` | Python | `requests==2.19.0` (vulnerable) in `requirements.txt`. Tests run with pytest. |

The end-to-end script copies each sample to a temporary folder before running anything, so the samples in this repository are never modified.

Run: `npm run e2e` (requires network access and, for Maven, `mvn` on PATH).

Notes from the Phase 5 runs:

- `maven-vuln/pom.xml` sets `maven.compiler.source` and `target` to 11, not `release`. The development sandbox has JDK 21 as the Maven runtime and JDK 11 as the `javac` on PATH, and `--release` fails there. Source/target builds on both.
- `mvn` writes `target/` into the temporary copy. `target/` and `node_modules/` are build output. PatchPilot's snapshots do not track them, so the restore check ignores them, and rollback does not remove them.
- Validation runs Python with `PYTHONDONTWRITEBYTECODE=1` and pytest with `-p no:cacheprovider`, so the Python sample leaves no cache files behind.

