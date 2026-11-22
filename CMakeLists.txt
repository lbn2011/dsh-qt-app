cmake_minimum_required(VERSION 3.21)  # cmake_minimum_version: >= 3.21 (Qt 6 QML tooling requirement)

# ---------------------------------------------------------------------------
# dsh-qt-app — DSH Qt6/QML native UI host
#
# Requirements (kept in sync with README.md § "Qt6 requirements"):
#   * CMake      >= 3.21
#   * Qt         >= 6.5, components: Core, Gui, Quick, Qml, QuickControls2
#                (component Test is required by the QML tests added in phase 1c)
#   * Compiler   C++20 (MSVC 19.3x, clang 15+, gcc 11+)
#   * Node.js    >= 22.19 for the Cordis/TypeScript side; the N-API addon comes
#                from the separate dsh-qt-napi repository
#
# This file is never built on the development machine: builds run on GitHub
# Actions (see .github/workflows/build.yml).
# ---------------------------------------------------------------------------

project(dsh-qt-app
  VERSION 0.1.0
  DESCRIPTION "DSH Qt6/QML native UI profile"
  HOMEPAGE_URL "https://github.com/lbn2011/dsh-qt-app"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.5 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2)

qt_standard_project_setup()

# Host executable: loads qml/main.qml and exposes the build-time macros from
# qml/config.h to QML as the `dshQt` context property.
qt_add_executable(dsh-qt-app
  native/main.cpp
  qml/config.h)

target_include_directories(dsh-qt-app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/qml)

target_link_libraries(dsh-qt-app PRIVATE
  Qt6::Core
  Qt6::Gui
  Qt6::Quick
  Qt6::Qml
  Qt6::QuickControls2)

# QML sources are embedded as qrc:/qml/... so the executable is self-contained.
# Every .qml file under qml/ is picked up (components/, models/, views/ included),
# because main.qml imports them as directory imports and a missing file would only
# surface as a runtime "module not installed" error. CONFIGURE_DEPENDS re-globs on
# reconfigure so adding a view does not silently fall out of the bundle.
file(GLOB_RECURSE DSH_QML_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/qml/*.qml")

# --- phase 2m: Markdown renderer tree --------------------------------------
# qml/markdown/ holds the MarkdownNode renderer: Markdown.qml (the root that
# dispatches on node type) plus one component per AST node. The recursive glob
# above already reaches these files; registering the directory *explicitly* as
# well is deliberate defence in depth, because the failure mode if it were ever
# dropped from the bundle is a runtime "module not installed" for the message
# body only — the window would open and every message would render blank, which
# no compile-time check would catch. REMOVE_DUPLICATES keeps FILES clean when
# both globs return the same paths.
file(GLOB DSH_MARKDOWN_QML_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/qml/markdown/*.qml")

if(NOT DSH_MARKDOWN_QML_SOURCES)
  message(FATAL_ERROR "qml/markdown/ is empty or missing — the Markdown renderer tree would not be bundled")
endif()

list(APPEND DSH_QML_SOURCES ${DSH_MARKDOWN_QML_SOURCES})
list(REMOVE_DUPLICATES DSH_QML_SOURCES)
list(SORT DSH_QML_SOURCES)

list(LENGTH DSH_QML_SOURCES DSH_QML_SOURCE_COUNT)
list(LENGTH DSH_MARKDOWN_QML_SOURCES DSH_MARKDOWN_SOURCE_COUNT)
message(STATUS "dsh-qt-app: bundling ${DSH_QML_SOURCE_COUNT} QML sources, ${DSH_MARKDOWN_SOURCE_COUNT} of them Markdown components")

qt_add_resources(dsh-qt-app "qml_sources"
  PREFIX "/qml"
  BASE "${CMAKE_CURRENT_SOURCE_DIR}/qml"
  FILES ${DSH_QML_SOURCES})

# Fail the configure step loudly if the QML tree went missing, instead of
# shipping a host that cannot load its own entry point.
if(NOT DSH_QML_SOURCES)
  message(FATAL_ERROR "No QML sources found under qml/ — the resource bundle would be empty")
endif()

if(MSVC)
  target_compile_options(dsh-qt-app PRIVATE /W4 /permissive-)
else()
  target_compile_options(dsh-qt-app PRIVATE -Wall -Wextra -Wpedantic)
endif()

# `cmake --build build --target qmllint` lints every QML file; the CI test job
# calls it when the qmllint binary is available.
find_program(QMLLINT_EXECUTABLE NAMES qmllint HINTS "${QT6_INSTALL_PREFIX}/bin")
if(QMLLINT_EXECUTABLE)
  add_custom_target(qmllint
    COMMAND ${QMLLINT_EXECUTABLE} ${DSH_QML_SOURCES}
    COMMENT "Running qmllint on ${CMAKE_CURRENT_SOURCE_DIR}/qml"
    VERBATIM)
endif()

# ---------------------------------------------------------------------------
# phase 2m: Qt Quick Test target
#
# The CI test workflow drives `qmltestrunner` directly (see
# .github/workflows/test.yml); this target exists so the same suites can be run
# from a local CMake build with `cmake --build build --target qml-tests`.
# QT_QPA_PLATFORM=offscreen is forced because CI has no display server.
# ---------------------------------------------------------------------------
find_program(QMLTESTRUNNER_EXECUTABLE NAMES qmltestrunner HINTS "${QT6_INSTALL_PREFIX}/bin")
if(QMLTESTRUNNER_EXECUTABLE)
  add_custom_target(qml-tests
    COMMAND ${CMAKE_COMMAND} -E env QT_QPA_PLATFORM=offscreen
            ${QMLTESTRUNNER_EXECUTABLE}
            -input ${CMAKE_CURRENT_SOURCE_DIR}/tests/qml
            -import ${CMAKE_CURRENT_SOURCE_DIR}/qml
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Running Qt Quick Test suites from tests/qml"
    USES_TERMINAL
    VERBATIM)
else()
  message(STATUS "dsh-qt-app: qmltestrunner not found — the qml-tests target is unavailable")
endif()

# ---------------------------------------------------------------------------
# phase 2m: dsh-qt-napi staging
#
# The Markdown/GFM parser is NOT linked into this executable. cmark-gfm is
# compiled into the `dsh-qt-napi` Node addon (a separate repository), which
# parses Markdown and hands the AST to QML over the stdio bridge described in
# native/main.cpp. Linking cmark here would add a second, unreachable copy of the
# parser and duplicate symbols against the addon's static build, so the Qt build's
# only interest in the addon is its *artifact*: it must travel next to the
# executable so packaging ships a working renderer.
#
# Point -DDSH_QT_NAPI_DIR at a directory containing qt-bridge.node (either a
# prebuild/<platform>-<arch>/ directory or a build/Release directory). CI passes
# the artifact it just downloaded; local builds may leave it unset, in which case
# the host falls back to the degraded <pre> renderer at runtime.
# ---------------------------------------------------------------------------
set(DSH_QT_NAPI_DIR "" CACHE PATH
  "Directory holding the dsh-qt-napi addon (qt-bridge.node) to bundle with the app")

set(DSH_QT_NAPI_ADDON "" CACHE FILEPATH "Resolved dsh-qt-napi addon path (internal)")

# Also accept the location through the environment so CI (and `pnpm package`)
# do not have to thread a -D flag through every command line.
if(NOT DSH_QT_NAPI_DIR AND DEFINED ENV{DSH_QT_NAPI_DIR})
  set(DSH_QT_NAPI_DIR "$ENV{DSH_QT_NAPI_DIR}")
  message(STATUS "dsh-qt-app: DSH_QT_NAPI_DIR taken from the environment: ${DSH_QT_NAPI_DIR}")
endif()
if(DSH_QT_NAPI_DIR)
  if(NOT IS_DIRECTORY "${DSH_QT_NAPI_DIR}")
    message(FATAL_ERROR "DSH_QT_NAPI_DIR is not a directory: ${DSH_QT_NAPI_DIR}")
  endif()

  # Three layouts occur in practice, and the order below is deliberate rather
  # than accidental: `file(GLOB)` returns alphabetically sorted paths, so
  # globbing all candidates at once silently preferred build/Release over the
  # published prebuild/<triple>/ layout ("build" < "prebuild"). The published
  # layout wins because that is what the release workflow uploads.
  set(_dsh_qt_napi_candidates "")

  file(GLOB _dsh_qt_napi_prebuild "${DSH_QT_NAPI_DIR}/prebuild/*/qt-bridge.node")
  list(SORT _dsh_qt_napi_prebuild)
  list(APPEND _dsh_qt_napi_candidates ${_dsh_qt_napi_prebuild})
  list(APPEND _dsh_qt_napi_candidates
    "${DSH_QT_NAPI_DIR}/qt-bridge.node"
    "${DSH_QT_NAPI_DIR}/build/Release/qt-bridge.node"
    "${DSH_QT_NAPI_DIR}/build/Debug/qt-bridge.node")

  foreach(_candidate IN LISTS _dsh_qt_napi_candidates)
    if(EXISTS "${_candidate}")
      set(DSH_QT_NAPI_ADDON "${_candidate}")
      break()
    endif()
  endforeach()

  if(NOT DSH_QT_NAPI_ADDON)
    message(FATAL_ERROR
      "DSH_QT_NAPI_DIR=${DSH_QT_NAPI_DIR} contains no qt-bridge.node. "
      "Build the addon first (npm run build in dsh-qt-napi) or point the option at its prebuild/<triple>/ directory.")
  endif()

  message(STATUS "dsh-qt-app: bundling dsh-qt-napi addon ${DSH_QT_NAPI_ADDON}")
else()
  message(STATUS "dsh-qt-app: no DSH_QT_NAPI_DIR given — packaging will ship the degraded renderer")
endif()

# The addon is installed into exactly the layout the loader already searches, so
# a packaged app finds it with no environment variable set:
#
#   <app root>/dsh-qt-napi/prebuild/<platform>-<arch>/qt-bridge.node
#
# That is the `<searchRoot>/<pkg>/prebuild/<triple>/` rule in
# src/qt-bridge/napi-loader.ts, with searchRoot = the app directory. The triple
# mimics Node's process.platform/process.arch names because that is the string the
# loader builds, and it is computed HERE rather than taken from the input path
# (a local build/Release/ directory has no triple in its name).
if(WIN32)
  set(_dsh_qt_platform win32)
elseif(APPLE)
  set(_dsh_qt_platform darwin)
else()
  set(_dsh_qt_platform linux)
endif()

if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64|ARM64)$")
  set(_dsh_qt_arch arm64)
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
  set(_dsh_qt_arch x64)
else()
  set(_dsh_qt_arch "${CMAKE_SYSTEM_PROCESSOR}")
endif()

set(DSH_QT_NAPI_TRIPLE "${_dsh_qt_platform}-${_dsh_qt_arch}")
message(STATUS "dsh-qt-app: napi prebuild triple is ${DSH_QT_NAPI_TRIPLE}")

# ---------------------------------------------------------------------------
# Installation layout
#
#   bin/dsh-qt-app[.exe]                                  the host
#   dsh-qt-napi/prebuild/<platform>-<arch>/qt-bridge.node the addon (when staged)
#
# QML lives inside the executable's resource bundle, so no qml/ tree is installed.
# ---------------------------------------------------------------------------
install(TARGETS dsh-qt-app
  BUNDLE  DESTINATION .
  RUNTIME DESTINATION bin)

if(DSH_QT_NAPI_ADDON)
  install(FILES "${DSH_QT_NAPI_ADDON}"
    DESTINATION "dsh-qt-napi/prebuild/${DSH_QT_NAPI_TRIPLE}"
    COMPONENT napi)
endif()

# ---------------------------------------------------------------------------
# phase 2m: packaging
#
# `cmake --build build --target package-app` (wrapped by
# `pnpm -C dsh-qt-app package`) produces a standalone archive per platform:
#   Linux   → dsh-qt-app-<version>-Linux.tar.gz
#   Windows → dsh-qt-app-<version>-win64.zip   (NSIS installer when makensis exists)
#   macOS   → dsh-qt-app-<version>-Darwin.dmg
# The Linux archive is also produced as .zip so a single artifact name works for
# every runner. CPack runs from the build directory and only packages what
# `install()` staged, so a missing addon shows up as an installer without the
# renderer rather than a silently empty archive.
# ---------------------------------------------------------------------------
set(CPACK_PACKAGE_NAME "dsh-qt-app")
set(CPACK_PACKAGE_VENDOR "DeepSeek")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "DSH Qt6/QML native UI profile")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "dsh-qt-app")
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGE_CHECKSUM "SHA256")

if(WIN32)
  set(CPACK_GENERATOR "ZIP")
  # A real installer when NSIS is present; ZIP stays as the always-available
  # fallback so the matrix never fails on a missing toolchain component.
  find_program(MAKENSIS_EXECUTABLE NAMES makensis)
  if(MAKENSIS_EXECUTABLE)
    list(APPEND CPACK_GENERATOR "NSIS")
    set(CPACK_NSIS_DISPLAY_NAME "DSH Qt UI")
    set(CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL ON)
    set(CPACK_NSIS_MODIFY_PATH OFF)
  endif()
elseif(APPLE)
  set(CPACK_GENERATOR "DragNDrop")
  set(CPACK_DMG_VOLUME_NAME "DSH Qt UI")
  set(CPACK_DMG_FORMAT "UDBZ")
else()
  set(CPACK_GENERATOR "TGZ;ZIP")
endif()

set(CPACK_SOURCE_GENERATOR "")
set(CPACK_PACKAGE_FILE_NAME
  "${CPACK_PACKAGE_NAME}-${CPACK_PACKAGE_VERSION}-${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")

# Write finished artifacts to dist/package/ in the source tree rather than the
# build tree: `pnpm package` and CI both then look in exactly one place, and
# `dist/` is already git-ignored.
set(CPACK_OUTPUT_FILE_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/dist/package")

include(CPack)

# One entry point for packaging: stage, then run CPack in the build tree.
# `--config` keeps the output next to the build directory so CI can upload
# `build/*.tar.gz|*.zip|*.dmg` without guessing a path.
add_custom_target(package-app
  COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --config $<CONFIG> --target install
  COMMAND ${CMAKE_CPACK_COMMAND} --config ${CMAKE_BINARY_DIR}/CPackConfig.cmake
  DEPENDS dsh-qt-app
  WORKING_DIRECTORY ${CMAKE_BINARY_DIR}
  COMMENT "Packaging dsh-qt-app (CPack: ${CPACK_GENERATOR})"
  USES_TERMINAL
  VERBATIM)
