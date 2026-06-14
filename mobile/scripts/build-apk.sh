#!/usr/bin/env bash
# Build a signed release APK for sideloading (Phase 6).
#
# Pins JDK 17 because React Native 0.79 / AGP / Gradle 8.13 do not run on the
# JDK 21+ that may be the machine default. Reads signing material from
# credentials/keystore.properties via plugins/withReleaseSigning.js.
#
# Usage:
#   npm run build:apk            # prebuild (if needed) + assembleRelease
#   npm run build:apk -- --clean # force a clean prebuild first
set -euo pipefail

cd "$(dirname "$0")/.."   # -> mobile/

# --- JDK 17 -----------------------------------------------------------------
if [ -z "${JAVA_HOME:-}" ] || ! "${JAVA_HOME}/bin/java" -version 2>&1 | grep -q '"17'; then
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  fi
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  echo "ERROR: a JDK 17 is required but was not found. Install Temurin/Oracle JDK 17 and/or set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
echo "JAVA_HOME=$JAVA_HOME ($(java -version 2>&1 | head -1))"

# --- Android SDK ------------------------------------------------------------
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ ! -d "$ANDROID_HOME" ]; then
  echo "ERROR: ANDROID_HOME ($ANDROID_HOME) does not exist. Install the Android SDK." >&2
  exit 1
fi
echo "ANDROID_HOME=$ANDROID_HOME"

if [ ! -f credentials/keystore.properties ]; then
  echo "WARNING: credentials/keystore.properties not found — the release APK will be signed with the DEBUG key." >&2
fi

# --- Prebuild ---------------------------------------------------------------
PREBUILD_FLAGS=(--platform android --no-install)
if [ "${1:-}" = "--clean" ]; then PREBUILD_FLAGS+=(--clean); fi
if [ ! -d android ] || [ "${1:-}" = "--clean" ]; then
  CI=1 npx expo prebuild "${PREBUILD_FLAGS[@]}"
fi
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties

# --- Build ------------------------------------------------------------------
( cd android && ./gradlew assembleRelease )

APK="$(find android/app/build/outputs/apk/release -name '*.apk' | head -1)"
echo
echo "Built: $APK"
"$ANDROID_HOME"/build-tools/*/apksigner verify --print-certs "$APK" 2>/dev/null | grep -i 'Signer #1 certificate DN\|SHA-256' | head -3 || true
echo "Install with: adb install -r \"$APK\""
