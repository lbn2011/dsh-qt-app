# Third-party notices

`dsh-qt-app` itself is MIT-licensed (see `LICENSE`). This file lists the
components whose source or binaries travel with a packaged build, the exact
upstream identity that produced them, and where their licence text lives. It is
installed next to the executable so a redistributed package keeps its notices.

## dsh-qt-napi (N-API addon, `qt-bridge.node`)

- Repository: <https://github.com/lbn2011/dsh-qt-napi>
- Pinned commit: `87084a6901297a4fe9af997d4b8cdf9d829b0f67` (also recorded in
  `package.json` under `dshQtNapi.commit`; CI checks the checkout against it)
- Licence: MIT (the repository's `LICENSE`)
- Why it is bundled: the Qt host does not link a Markdown parser. It asks Node
  for an AST over the v1 stdio protocol, so the addon is the only cmark-gfm
  build in the product and must ship beside the executable.

## cmark-gfm (vendored inside dsh-qt-napi)

- Upstream: <https://github.com/github/cmark-gfm>
- Version: `0.29.0.gfm.14`, partially vendored (parser sources; the upstream
  test suite is not vendored)
- Licence: BSD-2-Clause

```
Copyright (c) 2014, John MacFarlane

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

A byte-for-byte copy of the upstream `COPYING` is retained in the addon
repository at `vendor/cmark-gfm/COPYING`; its `PROVENANCE.md` records the
0.29.0.gfm.14 import. Nothing here re-licenses that code.

## Qt 6 (linked at build time, not redistributed by this repository)

The executable links Qt 6 (Core, Gui, Quick, Qml, QuickControls2; optionally
WebEngineQuick). Qt is distributed under LGPL-3.0 / GPL-3.0 / commercial terms;
this repository does not vendor or redistribute Qt binaries. Installers built
from a Qt installation inherit whatever terms that installation carries.

Qt WebEngine is an optional, compile-time feature (`-DDSH_QT_WEBENGINE=ON`
with the `qtwebengine` module installed; the build reports
`DSH_QT_HAS_WEBENGINE=1`). The `qt-webengine` CI job is configured to build
and exercise that branch. That job has run on a hosted `ubuntu-22.04` runner
(workflow run 45444359081, commit `5671824`): it configured with
`-DDSH_QT_WEBENGINE=ON`, asserted that the built binary links
`libQt6WebEngineQuick`, and passed both real-Chromium cases — embedded
load/token/close and the external-browser launch. Linux is therefore verified;
Windows and macOS WebEngine runs are not covered by CI. When the feature is
enabled the executable links Qt WebEngine and Chromium, and the notices below
cover them. Qt WebEngine itself is under the
LGPL-3.0 (with the usual Qt commercial alternative); Chromium is under the
BSD-3-Clause licence and carries the additional third-party notices shipped
inside the Qt WebEngine runtime. None of those libraries, their resources, or
the Chromium sandbox helper are copied into this repository's package. An
archive built with no staged N-API addon contains only `bin/dsh-qt-app`,
`LICENSE`, and this file. When a `qt-bridge.node` addon is staged, the archive
additionally contains `dsh-qt-napi/prebuild/<triple>/qt-bridge.node`, whose
pinned-commit notices are the addon section above. A deployment that bundles
Qt/WebEngine binaries must reproduce the notices of the Qt installation it
copies from.

## JavaScript runtime dependencies

`@deepseek-ai/cordis` and the Cordis include/loader plugins are installed by
`pnpm` at build/test time and are not copied into the CMake package. Their
licences are recorded in `pnpm-lock.yaml` and in each package's `LICENSE`.
