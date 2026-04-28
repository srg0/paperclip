#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-paperclip-onboard-smoke}"
HOST_PORT="${HOST_PORT:-3131}"
PAPERCLIPAI_VERSION="${PAPERCLIPAI_VERSION:-latest}"
DATA_DIR="${DATA_DIR:-$REPO_ROOT/data/docker-onboard-smoke}"
HOST_UID="${HOST_UID:-$(id -u)}"
SMOKE_RUNTIME="${SMOKE_RUNTIME:-npm}"
SMOKE_DETACH="${SMOKE_DETACH:-false}"
SMOKE_METADATA_FILE="${SMOKE_METADATA_FILE:-}"
PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-http://localhost:${HOST_PORT}}"
SMOKE_AUTO_BOOTSTRAP="${SMOKE_AUTO_BOOTSTRAP:-true}"
SMOKE_ADMIN_NAME="${SMOKE_ADMIN_NAME:-Smoke Admin}"
SMOKE_ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-smoke-admin@paperclip.local}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-paperclip-smoke-password}"
CONTAINER_NAME="${IMAGE_NAME//[^a-zA-Z0-9_.-]/-}"
SOURCE_REPO_PATH="/workspace/paperclip"
SOURCE_WORKDIR="/paperclip/cache/source-runtime"
LOG_PID=""
COOKIE_JAR=""
TMP_DIR=""
PRESERVE_CONTAINER_ON_EXIT="false"

mkdir -p "$DATA_DIR"

cleanup() {
  if [[ -n "$LOG_PID" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$PRESERVE_CONTAINER_ON_EXIT" != "true" ]]; then
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

container_is_running() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [[ "$running" == "true" ]]
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-60}"
  local sleep_seconds="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! container_is_running; then
      echo "Smoke bootstrap failed: container $CONTAINER_NAME exited before $url became ready" >&2
      docker logs "$CONTAINER_NAME" >&2 || true
      return 1
    fi
    sleep "$sleep_seconds"
  done
  if ! container_is_running; then
    echo "Smoke bootstrap failed: container $CONTAINER_NAME exited before readiness check completed" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
  fi
  return 1
}

build_onboard_cmd() {
  case "$SMOKE_RUNTIME" in
    npm|"")
      cat <<'EOF'
set -euo pipefail
mkdir -p "$PAPERCLIP_HOME"
npx --yes "paperclipai@${PAPERCLIPAI_VERSION}" onboard --yes --data-dir "$PAPERCLIP_HOME"
EOF
      ;;
    source)
      cat <<'EOF'
set -euo pipefail
mkdir -p "$PAPERCLIP_HOME"
mkdir -p /paperclip/cache/pnpm-store /paperclip/cache/source-runtime
if [[ ! -f /paperclip/cache/source-runtime/.prepared ]]; then
  rm -rf /paperclip/cache/source-runtime
  mkdir -p /paperclip/cache/source-runtime
  tar \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=.next \
    --exclude=dist \
    -cf - \
    -C /workspace/paperclip \
    . | tar -xf - -C /paperclip/cache/source-runtime
  cd /paperclip/cache/source-runtime
  env \
    HOME="$HOME" \
    npm_config_userconfig="$HOME/.npmrc" \
    pnpm_config_store_dir="/paperclip/cache/pnpm-store" \
    pnpm_config_virtual_store_dir=".pnpm" \
    pnpm install --frozen-lockfile
  env \
    HOME="$HOME" \
    npm_config_userconfig="$HOME/.npmrc" \
    pnpm -r --if-present build
  touch /paperclip/cache/source-runtime/.prepared
fi
cd /paperclip/cache/source-runtime
env \
  HOME="$HOME" \
  npm_config_userconfig="$HOME/.npmrc" \
  pnpm paperclipai onboard --yes --data-dir "$PAPERCLIP_HOME"
EOF
      ;;
    *)
      echo "Unsupported SMOKE_RUNTIME: $SMOKE_RUNTIME" >&2
      return 1
      ;;
  esac
}

build_bootstrap_cmd() {
  case "$SMOKE_RUNTIME" in
    npm|"")
      cat <<'EOF'
timeout 20s npx --yes "paperclipai@${PAPERCLIPAI_VERSION}" auth bootstrap-ceo --data-dir "$PAPERCLIP_HOME" --base-url "$PAPERCLIP_PUBLIC_URL"
EOF
      ;;
    source)
      cat <<'EOF'
cd /paperclip/cache/source-runtime
env \
  HOME="$HOME" \
  npm_config_userconfig="$HOME/.npmrc" \
  timeout 20s pnpm paperclipai auth bootstrap-ceo --data-dir "$PAPERCLIP_HOME" --base-url "$PAPERCLIP_PUBLIC_URL"
EOF
      ;;
    *)
      echo "Unsupported SMOKE_RUNTIME: $SMOKE_RUNTIME" >&2
      return 1
      ;;
  esac
}

write_metadata_file() {
  if [[ -z "$SMOKE_METADATA_FILE" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$SMOKE_METADATA_FILE")"
  {
    printf 'SMOKE_BASE_URL=%q\n' "$PAPERCLIP_PUBLIC_URL"
    printf 'SMOKE_ADMIN_EMAIL=%q\n' "$SMOKE_ADMIN_EMAIL"
    printf 'SMOKE_ADMIN_PASSWORD=%q\n' "$SMOKE_ADMIN_PASSWORD"
    printf 'SMOKE_CONTAINER_NAME=%q\n' "$CONTAINER_NAME"
    printf 'SMOKE_DATA_DIR=%q\n' "$DATA_DIR"
    printf 'SMOKE_IMAGE_NAME=%q\n' "$IMAGE_NAME"
    printf 'SMOKE_PAPERCLIPAI_VERSION=%q\n' "$PAPERCLIPAI_VERSION"
    printf 'SMOKE_RUNTIME=%q\n' "$SMOKE_RUNTIME"
  } >"$SMOKE_METADATA_FILE"
}

generate_bootstrap_invite_url() {
  local bootstrap_output
  local bootstrap_status
  local bootstrap_cmd
  bootstrap_cmd="$(build_bootstrap_cmd)"
  if bootstrap_output="$(
    docker exec \
      -e PAPERCLIP_DEPLOYMENT_MODE="$PAPERCLIP_DEPLOYMENT_MODE" \
      -e PAPERCLIP_DEPLOYMENT_EXPOSURE="$PAPERCLIP_DEPLOYMENT_EXPOSURE" \
      -e PAPERCLIP_PUBLIC_URL="$PAPERCLIP_PUBLIC_URL" \
      -e PAPERCLIP_HOME="/paperclip" \
      "$CONTAINER_NAME" bash -lc \
      "$bootstrap_cmd" \
      2>&1
  )"; then
    bootstrap_status=0
  else
    bootstrap_status=$?
  fi

  if [[ $bootstrap_status -ne 0 && $bootstrap_status -ne 124 ]]; then
    echo "Smoke bootstrap failed: could not run bootstrap-ceo inside container" >&2
    printf '%s\n' "$bootstrap_output" >&2
    return 1
  fi

  local invite_url
  invite_url="$(
    printf '%s\n' "$bootstrap_output" \
      | grep -o 'https\?://[^[:space:]]*/invite/pcp_bootstrap_[[:alnum:]]*' \
      | tail -n 1
  )"

  if [[ -z "$invite_url" ]]; then
    echo "Smoke bootstrap failed: bootstrap-ceo did not print an invite URL" >&2
    printf '%s\n' "$bootstrap_output" >&2
    return 1
  fi

  if [[ $bootstrap_status -eq 124 ]]; then
    echo "    Smoke bootstrap: bootstrap-ceo timed out after printing invite URL; continuing" >&2
  fi

  printf '%s\n' "$invite_url"
}

post_json_with_cookies() {
  local url="$1"
  local body="$2"
  local output_file="$3"
  local http_status
  if ! http_status="$(curl -sS \
    -o "$output_file" \
    -w "%{http_code}" \
    -c "$COOKIE_JAR" \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_PUBLIC_URL" \
    -X POST \
    "$url" \
    --data "$body")"; then
    printf '000'
    return 0
  fi
  printf '%s' "$http_status"
}

get_with_cookies() {
  local url="$1"
  curl -fsS \
    -c "$COOKIE_JAR" \
    -b "$COOKIE_JAR" \
    -H "Accept: application/json" \
    "$url"
}

sign_up_or_sign_in() {
  local signup_response="$TMP_DIR/signup.json"
  local signup_status
  local signup_attempt
  for ((signup_attempt = 1; signup_attempt <= 12; signup_attempt += 1)); do
    signup_status="$(post_json_with_cookies \
      "$PAPERCLIP_PUBLIC_URL/api/auth/sign-up/email" \
      "{\"name\":\"$SMOKE_ADMIN_NAME\",\"email\":\"$SMOKE_ADMIN_EMAIL\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}" \
      "$signup_response")"
    if [[ "$signup_status" =~ ^2 ]]; then
      echo "    Smoke bootstrap: created admin user $SMOKE_ADMIN_EMAIL"
      return 0
    fi
    if [[ "$signup_status" == "000" || "$signup_status" =~ ^5 ]]; then
      sleep 1
      continue
    fi
    break
  done

  local signin_response="$TMP_DIR/signin.json"
  local signin_status
  local signin_attempt
  for ((signin_attempt = 1; signin_attempt <= 12; signin_attempt += 1)); do
    signin_status="$(post_json_with_cookies \
      "$PAPERCLIP_PUBLIC_URL/api/auth/sign-in/email" \
      "{\"email\":\"$SMOKE_ADMIN_EMAIL\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}" \
      "$signin_response")"
    if [[ "$signin_status" =~ ^2 ]]; then
      echo "    Smoke bootstrap: signed in existing admin user $SMOKE_ADMIN_EMAIL"
      return 0
    fi
    if [[ "$signin_status" == "000" || "$signin_status" =~ ^5 ]]; then
      sleep 1
      continue
    fi
    break
  done

  echo "Smoke bootstrap failed: could not sign up or sign in admin user" >&2
  echo "Sign-up response:" >&2
  cat "$signup_response" >&2 || true
  echo >&2
  echo "Sign-in response:" >&2
  cat "$signin_response" >&2 || true
  echo >&2
  return 1
}

auto_bootstrap_authenticated_smoke() {
  local health_url="$PAPERCLIP_PUBLIC_URL/api/health"
  local health_json
  health_json="$(curl -fsS "$health_url")"
  if [[ "$health_json" != *'"deploymentMode":"authenticated"'* ]]; then
    return 0
  fi

  sign_up_or_sign_in

  if [[ "$health_json" == *'"bootstrapStatus":"ready"'* ]]; then
    echo "    Smoke bootstrap: instance already ready"
  else
    local invite_url
    invite_url="$(generate_bootstrap_invite_url)"
    echo "    Smoke bootstrap: generated bootstrap invite via auth bootstrap-ceo"

    local invite_token="${invite_url##*/}"
    local accept_response="$TMP_DIR/accept.json"
    local accept_status
    local accept_attempt
    for ((accept_attempt = 1; accept_attempt <= 12; accept_attempt += 1)); do
      accept_status="$(post_json_with_cookies \
        "$PAPERCLIP_PUBLIC_URL/api/invites/$invite_token/accept" \
        '{"requestType":"human"}' \
        "$accept_response")"
      if [[ "$accept_status" =~ ^2 ]]; then
        break
      fi
      if [[ "$accept_status" == "000" || "$accept_status" == "404" || "$accept_status" =~ ^5 ]]; then
        sleep 1
        continue
      fi
      break
    done
    if [[ ! "$accept_status" =~ ^2 ]]; then
      echo "Smoke bootstrap failed: bootstrap invite acceptance returned HTTP $accept_status" >&2
      cat "$accept_response" >&2 || true
      echo >&2
      return 1
    fi
    echo "    Smoke bootstrap: accepted bootstrap invite"
  fi

  local session_json
  session_json="$(get_with_cookies "$PAPERCLIP_PUBLIC_URL/api/auth/get-session")"
  if [[ "$session_json" != *'"userId"'* ]]; then
    echo "Smoke bootstrap failed: no authenticated session after bootstrap" >&2
    echo "$session_json" >&2
    return 1
  fi

  local companies_json
  companies_json="$(get_with_cookies "$PAPERCLIP_PUBLIC_URL/api/companies")"
  if [[ "${companies_json:0:1}" != "[" ]]; then
    echo "Smoke bootstrap failed: board companies endpoint did not return JSON array" >&2
    echo "$companies_json" >&2
    return 1
  fi

  echo "    Smoke bootstrap: board session verified"
  echo "    Smoke admin credentials: $SMOKE_ADMIN_EMAIL / $SMOKE_ADMIN_PASSWORD"
}

echo "==> Building onboard smoke image"
docker build \
  --build-arg PAPERCLIPAI_VERSION="$PAPERCLIPAI_VERSION" \
  --build-arg HOST_UID="$HOST_UID" \
  -f "$REPO_ROOT/docker/Dockerfile.onboard-smoke" \
  -t "$IMAGE_NAME" \
  "$REPO_ROOT"

echo "==> Running onboard smoke container"
echo "    UI should be reachable at: http://localhost:$HOST_PORT"
echo "    Public URL: $PAPERCLIP_PUBLIC_URL"
echo "    Smoke auto-bootstrap: $SMOKE_AUTO_BOOTSTRAP"
echo "    Detached mode: $SMOKE_DETACH"
echo "    Runtime mode: $SMOKE_RUNTIME"
echo "    Data dir: $DATA_DIR"
echo "    Deployment: $PAPERCLIP_DEPLOYMENT_MODE/$PAPERCLIP_DEPLOYMENT_EXPOSURE"
if [[ "$SMOKE_DETACH" != "true" ]]; then
  echo "    Live output: onboard banner and server logs stream in this terminal (Ctrl+C to stop)"
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
container_cmd="$(build_onboard_cmd)"
docker_run_args=(
  -d
  --rm
  --name "$CONTAINER_NAME"
  -p "$HOST_PORT:3100"
  -e HOST=0.0.0.0
  -e PORT=3100
  -e PAPERCLIP_DEPLOYMENT_MODE="$PAPERCLIP_DEPLOYMENT_MODE"
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE="$PAPERCLIP_DEPLOYMENT_EXPOSURE"
  -e PAPERCLIP_PUBLIC_URL="$PAPERCLIP_PUBLIC_URL"
  -e PAPERCLIPAI_VERSION="$PAPERCLIPAI_VERSION"
  -v "$DATA_DIR:/paperclip"
)
if [[ "$SMOKE_RUNTIME" == "source" ]]; then
  docker_run_args+=(-v "$REPO_ROOT:${SOURCE_REPO_PATH}")
fi

docker run "${docker_run_args[@]}" \
  "$IMAGE_NAME" bash -lc "$container_cmd" >/dev/null

if [[ "$SMOKE_DETACH" != "true" ]]; then
  docker logs -f "$CONTAINER_NAME" &
  LOG_PID=$!
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-onboard-smoke.XXXXXX")"
COOKIE_JAR="$TMP_DIR/cookies.txt"

startup_attempts=90
if [[ "$SMOKE_RUNTIME" == "source" ]]; then
  startup_attempts=300
fi

if ! wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" "$startup_attempts" 1; then
  echo "Smoke bootstrap failed: server did not become ready at $PAPERCLIP_PUBLIC_URL/api/health" >&2
  exit 1
fi

if [[ "$SMOKE_AUTO_BOOTSTRAP" == "true" && "$PAPERCLIP_DEPLOYMENT_MODE" == "authenticated" ]]; then
  auto_bootstrap_authenticated_smoke
fi

write_metadata_file

if [[ "$SMOKE_DETACH" == "true" ]]; then
  PRESERVE_CONTAINER_ON_EXIT="true"
  echo "==> Smoke container ready for automation"
  echo "    Smoke base URL: $PAPERCLIP_PUBLIC_URL"
  echo "    Smoke admin credentials: $SMOKE_ADMIN_EMAIL / $SMOKE_ADMIN_PASSWORD"
  if [[ -n "$SMOKE_METADATA_FILE" ]]; then
    echo "    Smoke metadata file: $SMOKE_METADATA_FILE"
  fi
  exit 0
fi

wait "$LOG_PID"
