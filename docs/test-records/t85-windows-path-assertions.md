# T85 — the archive gate's path assertions on Windows

Fixes T84-1 on top of `d9761df5f258ef97400d1d17e90e234e80a64842`. Test-only change:
`scripts/check-package-addon.mjs` is untouched, so no format, digest, exit-code or
path check is relaxed.

## What broke

`typescript (windows-2022)` failed on candidate `d9761df` (run
[45625466818](https://github.com/lbn2011/dsh-qt-app/actions/runs/45625466818), job
`139244355774`): `# tests 519 / # pass 511 / # fail 2 / # skipped 6`.

```
not ok 5 - accepts a package that carries the addon for its own triple
  tests/check-package-addon.test.ts:109
not ok 19 - runs from a checkout path that needs URL escaping (T80-1)
  tests/check-package-addon.test.ts:242
```

Both assertions pinned the reported addon path as a POSIX string:

```ts
assert.match(result.stdout, /dsh-qt-napi\/prebuild\/linux-x64\/qt-bridge\.node is ELF/u)
assert.match(result.stdout, /dsh-qt-napi\/prebuild\/win32-x64\/qt-bridge\.node is PE/u)
```

The gate reports `rel: relative(dir, addon.path)` (`scripts/check-package-addon.mjs:275`),
and `path.relative()` spells that with the host separator, so on windows-2022 the same
line reads `dsh-qt-napi\prebuild\win32-x64\qt-bridge.node`. The gate was right; the
assertion assumed one separator. Messages that the gate builds from literal POSIX
strings (`:224` `no dsh-qt-napi/prebuild/*/qt-bridge.node`, `:232` `${list}`) were
unaffected, which is why only these two assertions went red.

## The change

`tests/check-package-addon.test.ts` only:

- `loaderAddonPath(triple)` builds `check-package-addon: dsh-qt-napi<sep>prebuild<sep><triple><sep>qt-bridge\.node is `
  with `sep = '[\\/]'`. The exact loader path for the requested triple is still pinned;
  only the separator is flexible.
- The two failing assertions now use it, and each keeps the strict tail next to it:
  `is ELF sha256 [0-9a-f]{64} (target linux-x64)` / `is PE sha256 [0-9a-f]{64} (target win32-x64)`,
  plus `<triple> package carries the addon at the path the loader searches`. Format,
  digest and target are unchanged from before.
- New tests:
  - `accepts the <job> CI sample (T84-1)` — replays the verbatim stdout of both CI jobs
    (windows-2022 with `\` and CRLF, ubuntu-22.04 with `/`).
  - `rejects the same file name reported for another directory (T84-1)` — the same
    `qt-bridge.node` reported for `prebuild/linux-x64/` or for `vendor/dsh-qt-napi/prebuild/win32-x64/`
    must not satisfy the `win32-x64` assertion, in either separator spelling.
  - `rejects a package whose addon sits in a same-named directory elsewhere` — a package
    whose only addon lives at `vendor/dsh-qt-napi/prebuild/win32-x64/qt-bridge.node`
    exits 1 with `no dsh-qt-napi/prebuild/*/qt-bridge.node …`, i.e. the loader path is
    still the only accepted location.

## Red then green

Red, reproduced without a Windows runner by replaying the two `d9761df` assertions
against the real CI stdout (`/tmp/t85-red-replay.mjs`):

```
windows-2022 line 242 (win32-x64)   old(d9761df)=NO MATCH  new=match
ubuntu-22.04 line 109 (linux-x64)   old(d9761df)=match     new=match

old assertions red on 1 of 2 CI samples
```

The one sample that is red is exactly the job that failed in CI, and the Linux sample
that was green stays green — so the replay reproduces T84-1 rather than papering over it.

Green, in this worktree:

| command | result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | exit 0 (tsx 4.23.15, typescript 5.9.3, @types/node 26.6.6) |
| `node --test tests/check-package-addon.test.ts` | exit 0 — `tests 22 / pass 22 / fail 0 / skipped 0` |
| `node scripts/gate.mjs -- pnpm test` | exit 0 — `tests 523 / pass 521 / fail 0 / skipped 2` |
| `git diff --check` | exit 0, no output |

The suite grew from 519 to 523 tests: the four new cases above.

## Production logic is unchanged

```
$ git diff --name-only d9761df5f258ef97400d1d17e90e234e80a64842
docs/test-records/t85-windows-path-assertions.md
tests/check-package-addon.test.ts
```

No file under `scripts/`, no workflow, no CMake rule. The gate's checks, messages and
exit codes are byte-identical to the reviewed `d9761df`, and `scripts/check-archive.sh`
is untouched.

## Limits

- The green run above is Linux, where the gate emits `/`. The Windows spelling is
  covered by the replayed CI sample and by the separator-agnostic assertion, not by a
  local Windows execution. Confirmation needs the next windows-2022 run of
  `typescript` (and of the `packaging` / `qt build` gate steps).
- macOS remains not validated: `qt build (macos-14)` and `typescript (macos-14)` are
  cancelled within a second of starting because no runner is available. The `darwin-*`
  branch of the gate and of the CMake staging rules is still exercised only by unit tests.
- Nothing was pushed from this task; the candidate SHA is fixed locally and needs an
  independent review before it goes to `dev/phase3-i9`.
