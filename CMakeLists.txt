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

list(SORT DSH_QML_SOURCES)

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

install(TARGETS dsh-qt-app
  BUNDLE  DESTINATION .
  RUNTIME DESTINATION bin)
