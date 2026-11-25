# T82 — the archive gate now actually runs on Windows

Scope: `scripts/check-package-addon.mjs` (entry guard only) plus the tests that
pin the behaviour. Base commit: `c00f2ef77b89ba4444bdf2668b457a2e0c5bd502`
(the candidate T80 verified). No workflow, CMake or packaging change; nothing is
pushed from this record.

## The defect (T80-1)

The gate ended with:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

`import.meta.url` is a proper file URL (`file:///D:/a/dsh-qt-app/...`), while the
hand-built string keeps the raw path (`file://D:\a\dsh-qt-app\...`). The
comparison is therefore never true on Windows, `main()` never runs, and the
process exits 0 with no output at all. Observed on the hosted runner:
`typescript (windows-2022)` failed with `assert.match(result.stdout, ...)`
receiving `''` while `assert.equal(result.status, 0)` passed — a gate that
silently passes is worse than no gate, because `packaging (windows-2022)` and
`qt build (windows-2022)` both reported success while checking nothing.

The same comparison also misses paths that a file URL must percent-encode, so
the defect is reproducible on Linux without a Windows runner: a checkout path
containing a space or `#` was enough.

## The fix

```js
import { pathToFileURL } from 'node:url'
...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
```

`pathToFileURL` performs exactly the conversion the guard needs (drive letters,
UNC prefixes, spaces, `#`, `%`), so "was I started directly?" is decided by the
same rules on every platform. `process.argv[1]` is still checked, because an
imported module has no script argument. Nothing else in the file changed: exit
codes stay 0/1/2, messages are unchanged, and `scripts/check-archive.sh` (the
Linux `.tar.gz` check) is untouched.

## Red then green

The three new subprocess tests copy the CLI into `$TMPDIR/dsh gate path /checkout #1 %41/`
— a directory containing a space, a `#` and a literal `%41` — and run it from
there. Red on the base commit:

```
$ node --test tests/check-package-addon.test.ts        # base c00f2ef
✖ runs from a checkout path that needs URL escaping (T80-1)
✖ rejects a wrong digest from a checkout path that needs URL escaping (T80-1)
✖ rejects the wrong architecture from a checkout path that needs URL escaping (T80-1)
ℹ tests 18
ℹ pass 15
ℹ fail 3
```

Green after the one-line guard change:

```
$ node --test tests/check-package-addon.test.ts        # this commit
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

The failures are the real symptom, not a missing feature: `status` was 0 and
`stdout` empty for all three, i.e. the CLI did nothing.

## Real archives, old guard versus new guard

Same unpacked archives from build run `45621962577` (commit `c00f2ef`), same
hostile checkout path:

```
# old guard, real Windows package -> silent no-op
$ node "<hostile>/scripts-old/check-package-addon.mjs" \
    --dir /tmp/t80/build/x-win/dsh-qt-app-0.1.0-Windows-AMD64 --triple win32-x64
OLD_WIN_EXIT=0            # no output at all

# new guard, same package
$ node "<hostile>/scripts/check-package-addon.mjs" \
    --dir /tmp/t80/build/x-win/dsh-qt-app-0.1.0-Windows-AMD64 --triple win32-x64
check-package-addon: dsh-qt-napi/prebuild/win32-x64/qt-bridge.node is PE sha256 c0b4b7c7949d810dd1128bd7b7ded527ea32435653549759e633dad7ad9fae27 (target win32-x64)
check-package-addon: win32-x64 package carries the addon at the path the loader searches
NEW_WIN_EXIT=0

# new guard, real Linux package
check-package-addon: dsh-qt-napi/prebuild/linux-x64/qt-bridge.node is ELF sha256 86bdc061d786dcefbb992f54dcef974ee7dc50862575e46fbb626eef6731a60f (target linux-x64)
check-package-addon: linux-x64 package carries the addon at the path the loader searches
NEW_LINUX_EXIT=0

# new guard, the T29-A archive that shipped an ELF under win32-x64
check-package-addon: dsh-qt-napi/prebuild/win32-x64/qt-bridge.node is ELF, but a win32-x64 package needs PE — the loader would fail require() and degrade silently
NEW_T29A_EXIT=1
```

Import stays side-effect free — `await import(pathToFileURL(cli).href)` returns
without printing anything or running checks (`tests/check-package-addon.test.ts`,
`importing the gate runs no checks`).

## Verification

| command | result |
| --- | --- |
| `node --test tests/check-package-addon.test.ts` | 18 tests, 18 pass, 0 fail |
| `node --check scripts/check-package-addon.mjs` | exit 0 |
| `git diff --check` | exit 0, no whitespace errors |

Local only. The Windows evidence for the fix itself is the subprocess table plus
the real-archive runs above; a hosted `windows-2022` run is still required to
show `check-package-addon:` lines in the CI log, and macOS remains
not-validated (both macOS jobs on the previous two runs were cancelled before
they started).
