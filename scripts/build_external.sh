#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OSD_SOURCE="${OSD_ROOT:-${ROOT_DIR}/../OpenSearch-Dashboards}"
if [[ ! -f "${OSD_SOURCE}/scripts/plugin_helpers.js" ]]; then
  echo "Dashboards build checkout is unavailable: ${OSD_SOURCE}" >&2
  exit 1
fi
SOURCE_VERSION="$(node -p "require(process.argv[1]).version" "${OSD_SOURCE}/package.json")"
TARGET_VERSION="${SOURCE_VERSION}"
BUILD_ARGS=("$@")
for index in "${!BUILD_ARGS[@]}"; do
  argument="${BUILD_ARGS[$index]}"
  if [[ "${argument}" == --opensearch-dashboards-version=* ]]; then
    TARGET_VERSION="${argument#*=}"
  elif [[ "${argument}" == --opensearch-dashboards-version ]]; then
    next_index=$((index + 1))
    TARGET_VERSION="${BUILD_ARGS[$next_index]:-}"
  fi
done
if [[ "${TARGET_VERSION}" != "${SOURCE_VERSION}" ]]; then
  echo "Dashboards checkout is ${SOURCE_VERSION}, but build target is ${TARGET_VERSION}. Set OSD_ROOT to a checkout of ${TARGET_VERSION}." >&2
  exit 1
fi
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/xdr-navigator-build.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT
BUILD_OSD="${STAGING}/OpenSearch-Dashboards"
mkdir -p "${BUILD_OSD}"
tar -C "${OSD_SOURCE}" --exclude='./.git' --exclude='./plugins' --exclude='./build' --exclude='./target' -cf - . | tar -C "${BUILD_OSD}" -xf -
git -C "${BUILD_OSD}" init -q
git -C "${BUILD_OSD}" add -A
git -C "${BUILD_OSD}" -c core.hooksPath=/dev/null -c user.name='XDR local build' -c user.email='build@localhost' commit -qm 'Disposable build source'
PLUGIN_DIR="${BUILD_OSD}/plugins/xdr-navigator"
mkdir -p "${PLUGIN_DIR}"
tar -C "${ROOT_DIR}" --exclude='./.git' --exclude='./node_modules' --exclude='./build' --exclude='./target' -cf - . | tar -C "${PLUGIN_DIR}" -xf -
cd "${PLUGIN_DIR}"
node ../../scripts/plugin_helpers build "$@"
mkdir -p "${ROOT_DIR}/build"
cp -f "${PLUGIN_DIR}/build/"*.zip "${ROOT_DIR}/build/"
