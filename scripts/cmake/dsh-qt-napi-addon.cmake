# Staging rules for the dsh-qt-napi addon artifact.
#
# The Markdown renderer lives in a separate repository (lbn2011/dsh-qt-napi) and
# reaches this build as a prebuilt `qt-bridge.node`. CMake's only job is to put
# the artifact for the *target* triple into
#
#   dsh-qt-napi/prebuild/<platform>-<arch>/qt-bridge.node
#
# which is the layout src/qt-bridge/napi-loader.ts searches at runtime.
#
# Why this file exists (T29-A)
# ---------------------------
# The previous rules globbed `prebuild/*/qt-bridge.node`, sorted the paths and
# took the first hit. dsh-qt-napi commits `prebuild/linux-x64/qt-bridge.node` on
# purpose (its .gitignore has `!prebuild/`), so a Windows job that had just staged
# `prebuild/win32-x64/` also had `prebuild/linux-x64/` on disk. "linux-x64" sorts
# before "win32-x64", the Windows package shipped the *Linux* ELF under
# prebuild/win32-x64/, the loader's require() failed and degraded silently — so
# every green signal stayed green and the release would have shipped a Windows app
# without a Markdown renderer.
#
# The rules are therefore strict on purpose:
#   1. prebuild/<target triple>/qt-bridge.node wins when present (exact hit).
#   2. If the tree carries prebuild/ directories but not the target triple, fail:
#      another platform's binary must never stand in for the target one.
#   3. Flat layouts (qt-bridge.node, build/Release, build/Debug) remain valid —
#      they are host builds, and a host build has no triple in its path.
#   4. Whatever is chosen must have the object format the target triple implies
#      (ELF / PE / Mach-O), so a mislabelled directory is caught at configure time
#      instead of inside a silent runtime fallback.
#   5. No DSH_QT_NAPI_DIR keeps the approved degraded renderer (mode=degraded).

# Map a Node platform/arch pair onto the prebuild directory name. The strings must
# match `prebuildTriple()` in src/qt-bridge/napi-loader.ts, which builds them from
# Node's own process.platform / process.arch.
function(dsh_qt_napi_triple_for platform arch out_var)
  set(known_platform FALSE)
  foreach(candidate win32 linux darwin)
    if(platform STREQUAL candidate)
      set(known_platform TRUE)
    endif()
  endforeach()
  if(NOT known_platform)
    message(FATAL_ERROR
      "dsh-qt-napi: unsupported platform '${platform}'. Supported: win32, linux, darwin.")
  endif()
  if(NOT arch)
    message(FATAL_ERROR "dsh-qt-napi: empty architecture for platform '${platform}'.")
  endif()
  set(${out_var} "${platform}-${arch}" PARENT_SCOPE)
endfunction()

# Triple for the artifact this build produces, i.e. the one the packaged app will
# look for on the machine it runs on.
function(dsh_qt_napi_target_triple out_var)
  if(WIN32)
    set(_platform win32)
  elseif(APPLE)
    set(_platform darwin)
  else()
    set(_platform linux)
  endif()

  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64|ARM64)$")
    set(_arch arm64)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
    set(_arch x64)
  else()
    set(_arch "${CMAKE_SYSTEM_PROCESSOR}")
  endif()

  dsh_qt_napi_triple_for("${_platform}" "${_arch}" _triple)
  set(${out_var} "${_triple}" PARENT_SCOPE)
endfunction()

# Object format of a binary, from its first four bytes: elf, pe, macho or unknown.
function(dsh_qt_napi_binary_format path out_var)
  set(format "unknown")
  if(EXISTS "${path}")
    file(READ "${path}" magic LIMIT 4 HEX)
    string(TOLOWER "${magic}" magic)
    if(magic MATCHES "^7f454c46")
      set(format elf)
    elseif(magic MATCHES "^4d5a")
      # 'MZ' — every PE image starts with the DOS stub; the PE header follows the
      # stub at e_lfanew, which is far past the bytes needed to reject an ELF.
      set(format pe)
    elseif(magic MATCHES "^(cffaedfe|cefaedfe|feedface|feedfacf|cafebabe|bebafeca)")
      set(format macho)
    endif()
  endif()
  set(${out_var} "${format}" PARENT_SCOPE)
endfunction()

# The format a triple implies. Unknown platforms yield an empty string so callers
# can warn instead of inventing a rule.
function(dsh_qt_napi_expected_format triple out_var)
  set(expected "")
  if(triple MATCHES "^win32-")
    set(expected pe)
  elseif(triple MATCHES "^linux-")
    set(expected elf)
  elseif(triple MATCHES "^darwin-")
    set(expected macho)
  endif()
  set(${out_var} "${expected}" PARENT_SCOPE)
endfunction()

function(dsh_qt_napi_format_label format out_var)
  if(format STREQUAL "elf")
    set(label "ELF")
  elseif(format STREQUAL "pe")
    set(label "PE")
  elseif(format STREQUAL "macho")
    set(label "Mach-O")
  else()
    set(label "unrecognised")
  endif()
  set(${out_var} "${label}" PARENT_SCOPE)
endfunction()

# Resolve the addon to bundle.
#
#   dsh_qt_napi_stage(<out_addon> <out_mode> <dir> <triple>)
#
# out_mode is "bundled" (out_addon is the artifact to install) or "degraded"
# (nothing to install; the app runs its fallback <pre> renderer). A wrong or
# ambiguous artifact is a FATAL_ERROR, never a silent substitution.
function(dsh_qt_napi_stage out_addon out_mode dir triple)
  set(addon "")
  set(mode "degraded")

  if(NOT dir)
    set(${out_addon} "" PARENT_SCOPE)
    set(${out_mode} "degraded" PARENT_SCOPE)
    return()
  endif()

  if(NOT IS_DIRECTORY "${dir}")
    message(FATAL_ERROR "DSH_QT_NAPI_DIR is not a directory: ${dir}")
  endif()

  # An explicit -DDSH_QT_NAPI_ADDON still wins, but it is held to the same format
  # rule as everything else: it is exactly the knob someone reaches for when
  # pointing at a foreign binary by mistake.
  if(DSH_QT_NAPI_ADDON AND EXISTS "${DSH_QT_NAPI_ADDON}")
    set(addon "${DSH_QT_NAPI_ADDON}")
    message(STATUS "dsh-qt-app: using the explicit DSH_QT_NAPI_ADDON ${addon}")
  else()
    set(exact "${dir}/prebuild/${triple}/qt-bridge.node")
    if(EXISTS "${exact}")
      set(addon "${exact}")
    else()
      # Report the triples that *are* present so the message names the mistake
      # instead of leaving the reader to list the directory.
      file(GLOB present_dirs LIST_DIRECTORIES true "${dir}/prebuild/*")
      set(foreign "")
      foreach(present IN LISTS present_dirs)
        if(IS_DIRECTORY "${present}" AND EXISTS "${present}/qt-bridge.node")
          get_filename_component(present_name "${present}" NAME)
          list(APPEND foreign "${present_name}")
        endif()
      endforeach()

      if(foreign)
        list(JOIN foreign ", " foreign_list)
        message(FATAL_ERROR
          "dsh-qt-app: DSH_QT_NAPI_DIR=${dir} has no addon for the target triple "
          "'${triple}'; it only carries prebuild/{${foreign_list}}. Refusing to bundle a "
          "binary built for another platform — the loader would fail require() and fall "
          "back to the degraded renderer without any error. Build or download the "
          "addon for ${triple} (prebuild/${triple}/qt-bridge.node).")
      endif()

      # Host build layouts: no triple in the path, so the host triple applies.
      foreach(candidate
          "${dir}/qt-bridge.node"
          "${dir}/build/Release/qt-bridge.node"
          "${dir}/build/Debug/qt-bridge.node")
        if(EXISTS "${candidate}")
          set(addon "${candidate}")
          break()
        endif()
      endforeach()

      if(NOT addon)
        message(FATAL_ERROR
          "DSH_QT_NAPI_DIR=${dir} contains no qt-bridge.node. "
          "Build the addon first (npm run build in dsh-qt-napi) or point the option at its prebuild/<triple>/ directory.")
      endif()
    endif()
  endif()

  dsh_qt_napi_binary_format("${addon}" _format)
  dsh_qt_napi_expected_format("${triple}" _expected)
  if(_expected)
    if(NOT _format STREQUAL _expected)
      dsh_qt_napi_format_label("${_format}" _got_label)
      dsh_qt_napi_format_label("${_expected}" _want_label)
      message(FATAL_ERROR
        "dsh-qt-app: the resolved addon ${addon} is ${_got_label}, but the target triple "
        "'${triple}' needs ${_want_label} (win32-* takes PE, linux-* takes ELF, darwin-* "
        "takes Mach-O). Refusing to package it: the loader would fail require() and "
        "silently degrade. Check which prebuild/<triple>/ directory the addon was "
        "staged into.")
    endif()
  else()
    message(WARNING
      "dsh-qt-app: no object-format rule for the target triple '${triple}'; "
      "the addon at ${addon} was not format-checked.")
  endif()

  set(mode "bundled")
  set(${out_addon} "${addon}" PARENT_SCOPE)
  set(${out_mode} "${mode}" PARENT_SCOPE)
endfunction()
