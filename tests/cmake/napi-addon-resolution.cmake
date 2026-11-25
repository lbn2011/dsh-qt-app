# Unit test for the dsh-qt-napi staging rules (scripts/cmake/dsh-qt-napi-addon.cmake).
#
# Script mode only: no Qt, no compiler, no network.
#
#   cmake -P tests/cmake/napi-addon-resolution.cmake            # current rules
#   cmake -P tests/cmake/napi-addon-resolution.cmake -DMODE=legacy   # red case
#
# MODE=legacy re-runs the baseline algorithm from 5671824 (tests/cmake/legacy-staging.cmake)
# through the same case table. It is expected to fail, which is what makes the
# T29-A regression reproducible rather than remembered; the failure transcript is
# recorded in docs/test-records/t77-napi-addon-selection.md.
#
# Case table (fixtures are fabricated; only the first bytes matter):
#   1. win32-x64 target with prebuild/linux-x64 *and* prebuild/win32-x64 on disk
#      → the win32-x64 PE must win, not the alphabetically first directory.
#   2. linux-x64 target with both directories on disk → the linux-x64 ELF wins.
#   3. darwin-arm64 target, only linux-x64 + win32-x64 on disk → hard failure:
#      a foreign platform must never stand in for the target.
#   4. win32-x64 target, only prebuild/linux-x64 on disk → hard failure.
#   5. A directory with no qt-bridge.node anywhere → hard failure naming the dir.
#   6. Host build layout (build/Release/qt-bridge.node, no prebuild/ tree) → used.
#   7. prebuild/win32-x64/qt-bridge.node that is really an ELF → hard failure
#      (the exact shape T29-A produced).
#   8. No DSH_QT_NAPI_DIR at all → the approved degraded renderer, not an error.
cmake_minimum_required(VERSION 3.21)

set(MODE "resolver" CACHE STRING "resolver (current rules) or legacy (baseline 5671824)")

if(NOT DEFINED DSH_QT_NAPI_TEST_ROOT)
  set(DSH_QT_NAPI_TEST_ROOT "${CMAKE_CURRENT_BINARY_DIR}/napi-addon-fixtures")
endif()
set(FIXTURES "${DSH_QT_NAPI_TEST_ROOT}")
file(REMOVE_RECURSE "${FIXTURES}")
file(MAKE_DIRECTORY "${FIXTURES}")

set(MODULE "${CMAKE_CURRENT_LIST_DIR}/../../scripts/cmake/dsh-qt-napi-addon.cmake")
set(LEGACY "${CMAKE_CURRENT_LIST_DIR}/legacy-staging.cmake")

if(MODE STREQUAL "resolver")
  include("${MODULE}")
  set(STAGE_FN "dsh_qt_napi_stage")
elseif(MODE STREQUAL "legacy")
  include("${LEGACY}")
  set(STAGE_FN "legacy_stage")
else()
  message(FATAL_ERROR "MODE must be resolver or legacy, got: ${MODE}")
endif()

# --- fixtures --------------------------------------------------------------

# Four-byte files whose leading bytes are the real object-format magic:
#   0x7f 'E' 'L' 'F' → ELF, 'M' 'Z' → PE, 0xcf 0xfa 0xed 0xfe → Mach-O (LE, 64-bit).
function(write_magic path kind)
  if(kind STREQUAL "elf")
    string(ASCII 127 69 76 70 magic)
  elseif(kind STREQUAL "pe")
    string(ASCII 77 90 80 69 magic)
  elseif(kind STREQUAL "macho")
    string(ASCII 207 250 237 254 magic)
  else()
    message(FATAL_ERROR "unknown fixture kind: ${kind}")
  endif()
  get_filename_component(dir "${path}" DIRECTORY)
  file(MAKE_DIRECTORY "${dir}")
  file(WRITE "${path}" "${magic}")
endfunction()

function(make_addon_tree root spec)
  # spec is a ';'-separated list of "relative/path=elf|pe|macho" entries.
  file(MAKE_DIRECTORY "${root}")
  foreach(entry IN LISTS spec)
    string(FIND "${entry}" "=" eq)
    string(SUBSTRING "${entry}" 0 ${eq} rel)
    math(EXPR after "${eq} + 1")
    string(SUBSTRING "${entry}" ${after} -1 kind)
    write_magic("${root}/${rel}" "${kind}")
  endforeach()
endfunction()

# --- assertions ------------------------------------------------------------

set(failures 0)
set(checks 0)

function(expect_ok name dir triple want_suffix want_mode)
  set(addon "")
  set(mode "")
  cmake_language(CALL ${STAGE_FN} addon mode "${dir}" "${triple}")
  math(EXPR checks "${checks} + 1")
  if(NOT mode STREQUAL want_mode)
    message(SEND_ERROR "FAIL ${name}: mode is '${mode}', expected '${want_mode}'")
    math(EXPR failures "${failures} + 1")
  elseif(NOT want_mode STREQUAL "bundled")
    message(STATUS "ok ${name}: mode=${mode}")
  elseif(addon STREQUAL "")
    message(SEND_ERROR "FAIL ${name}: no addon resolved")
    math(EXPR failures "${failures} + 1")
  else()
    file(TO_CMAKE_PATH "${addon}" addon_posix)
    string(FIND "${addon_posix}" "${want_suffix}" found)
    if(found EQUAL -1)
      message(SEND_ERROR "FAIL ${name}: resolved '${addon_posix}', expected suffix '${want_suffix}'")
      math(EXPR failures "${failures} + 1")
    else()
      message(STATUS "ok ${name}: ${addon_posix}")
    endif()
  endif()
  set(failures "${failures}" PARENT_SCOPE)
  set(checks "${checks}" PARENT_SCOPE)
endfunction()

function(expect_error name dir triple want_pattern)
  # A FATAL_ERROR would end this script, so each expected-failure case runs in a
  # child `cmake -P` process and is judged by its exit status and message.
  set(child "${FIXTURES}/child-${name}.cmake")
  file(TO_CMAKE_PATH "${dir}" dir_posix)
  file(TO_CMAKE_PATH "${MODULE}" module_posix)
  file(TO_CMAKE_PATH "${LEGACY}" legacy_posix)
  file(WRITE "${child}" "cmake_minimum_required(VERSION 3.21)
if(MODE STREQUAL \"resolver\")
  include(\"${module_posix}\")
  dsh_qt_napi_stage(out_addon out_mode \"${dir_posix}\" \"${triple}\")
else()
  include(\"${legacy_posix}\")
  legacy_stage(out_addon out_mode \"${dir_posix}\" \"${triple}\")
endif()
message(FATAL_ERROR \"UNEXPECTED-SUCCESS \${out_addon}\")
")
  execute_process(
    COMMAND "${CMAKE_COMMAND}" "-DMODE=${MODE}" -P "${child}"
    RESULT_VARIABLE rc
    OUTPUT_VARIABLE out
    ERROR_VARIABLE err)
  math(EXPR checks "${checks} + 1")
  set(combined "${out}${err}")
  # CMake wraps message() text at the terminal width, so a long fixture path can
  # split a phrase across two lines; match against a whitespace-collapsed copy.
  string(REGEX REPLACE "[ \n\r\t]+" " " combined "${combined}")
  if(rc EQUAL 0 OR combined MATCHES "UNEXPECTED-SUCCESS")
    message(SEND_ERROR "FAIL ${name}: staging succeeded, expected a hard failure")
    message(STATUS "  output: ${combined}")
    math(EXPR failures "${failures} + 1")
  elseif(NOT combined MATCHES "${want_pattern}")
    message(SEND_ERROR "FAIL ${name}: failure did not mention '${want_pattern}'")
    message(STATUS "  output: ${combined}")
    math(EXPR failures "${failures} + 1")
  else()
    message(STATUS "ok ${name}: rejected")
  endif()
  set(failures "${failures}" PARENT_SCOPE)
  set(checks "${checks}" PARENT_SCOPE)
endfunction()

# --- cases -----------------------------------------------------------------

set(both "${FIXTURES}/both")
make_addon_tree("${both}"
  "prebuild/linux-x64/qt-bridge.node=elf;prebuild/win32-x64/qt-bridge.node=pe")

set(linux_only "${FIXTURES}/linux-only")
make_addon_tree("${linux_only}" "prebuild/linux-x64/qt-bridge.node=elf")

set(flat "${FIXTURES}/flat")
make_addon_tree("${flat}" "build/Release/qt-bridge.node=elf")

set(mislabelled "${FIXTURES}/mislabelled")
make_addon_tree("${mislabelled}" "prebuild/win32-x64/qt-bridge.node=elf")

set(empty "${FIXTURES}/empty")
file(MAKE_DIRECTORY "${empty}")

# 1 + 2: the target triple decides, not the alphabet.
expect_ok("case1-win32-beats-sorting" "${both}" "win32-x64"
  "prebuild/win32-x64/qt-bridge.node" "bundled")
expect_ok("case2-linux-beats-sorting" "${both}" "linux-x64"
  "prebuild/linux-x64/qt-bridge.node" "bundled")

# 3 + 4: no substitution from another platform.
expect_error("case3-missing-darwin-triple" "${both}" "darwin-arm64" "linux-x64")
expect_error("case4-only-foreign-platform" "${linux_only}" "win32-x64" "linux-x64")

# 5: nothing to bundle at all.
expect_error("case5-no-addon-anywhere" "${empty}" "linux-x64" "contains no qt-bridge.node")

# 6: host build layout still works (no prebuild/ tree).
expect_ok("case6-host-build-layout" "${flat}" "linux-x64"
  "build/Release/qt-bridge.node" "bundled")

# 7: a mislabelled directory is a hard failure, not a shipped binary.
expect_error("case7-mislabelled-format" "${mislabelled}" "win32-x64" "ELF")

# 8: the approved no-addon mode.
expect_ok("case8-degraded-mode" "" "win32-x64" "" "degraded")

message(STATUS "---")
if(failures GREATER 0)
  message(FATAL_ERROR "napi-addon-resolution (${MODE}): ${failures} of ${checks} checks failed")
endif()
message(STATUS "napi-addon-resolution (${MODE}): all ${checks} checks passed")
