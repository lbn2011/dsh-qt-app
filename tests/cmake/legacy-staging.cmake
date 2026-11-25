# Baseline staging algorithm, verbatim from CMakeLists.txt at 5671824.
#
# Kept as a fixture so the T29-A regression stays reproducible: the test runner
# runs the same case table through this and through the current rules
# (scripts/cmake/dsh-qt-napi-addon.cmake). This copy is expected to FAIL cases
# 1, 3 and 4 — it globs prebuild/*/qt-bridge.node, sorts the paths and takes the
# first hit, so a checkout carrying both prebuild/linux-x64 and
# prebuild/win32-x64 resolves linux-x64 on Windows.
#
# Do not "fix" this file: it is the red case, not production code.

function(legacy_stage out_addon out_mode dir triple)
  set(addon "")
  set(mode "degraded")
  if(dir)
    if(NOT IS_DIRECTORY "${dir}")
      message(FATAL_ERROR "DSH_QT_NAPI_DIR is not a directory: ${dir}")
    endif()

    set(candidates "")
    file(GLOB prebuild "${dir}/prebuild/*/qt-bridge.node")
    list(SORT prebuild)
    list(APPEND candidates ${prebuild})
    list(APPEND candidates
      "${dir}/qt-bridge.node"
      "${dir}/build/Release/qt-bridge.node"
      "${dir}/build/Debug/qt-bridge.node")

    foreach(candidate IN LISTS candidates)
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
    set(mode "bundled")
  endif()
  set(${out_addon} "${addon}" PARENT_SCOPE)
  set(${out_mode} "${mode}" PARENT_SCOPE)
endfunction()
