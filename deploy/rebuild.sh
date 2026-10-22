#!/usr/bin/env bash
# Rebuild the portals from the commit in this folder, hosted copy first and then the local-model copy
# beside it, and check what came up (tracker IN-01; the steps are the ones in docs/setup/23).
#
#   deploy/rebuild.sh [--dry-run] [--skip-verify] [--allow-dirty]
#
#   --dry-run      print every command that would change something, and run none of them
#   --skip-verify  do not run `npm run verify` first (it takes about five minutes)
#   --allow-dirty  build although server/, web/ or docker-compose.yml differ from the commit; the
#                  build is then labelled <commit>-dirty and is not tagged
#
# It refuses to run from a folder that is not a git checkout, and from a tree whose server/, web/
# (their tests apart, which no image holds) or docker-compose.yml differ from HEAD: the build is
# named by the commit, and a name that lies is worse than none. It tags the images it replaces rollback-<day><month>, builds with BUILD_COMMIT
# and BUILD_TIME, waits for both containers of each copy to be healthy and asks what an anonymous
# caller can see. When all of that holds on a clean tree it makes the annotated tag live-<date> in
# this repository (it never pushes it: that is yours to do) and prints the check that needs a
# sign-in, which it cannot make.
set -euo pipefail

DRY=0
VERIFY=1
DIRTY_OK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --skip-verify) VERIFY=0 ;;
    --allow-dirty) DIRTY_OK=1 ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "rebuild.sh: unknown option $arg" >&2
      exit 2
      ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$ROOT")

say() { printf '%s\n' "$*"; }
fail() {
  printf 'rebuild.sh: %s\n' "$*" >&2
  exit 1
}
# Print a command, then run it unless this is a dry run.
run() {
  printf '+ %s\n' "$*"
  if [ "$DRY" -eq 0 ]; then "$@"; fi
}

git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 ||
  fail "$ROOT is not a git checkout. Run deploy/rebuild.sh from hcml-portal, the copy that has git."
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
# What goes into the images: server/ and web/, less their tests, and the compose file.
IMAGE_FILES=(server web docker-compose.yml ':(exclude,glob)**/__tests__/**' ':(exclude,glob)**/*.test.ts' ':(exclude,glob)**/*.test.tsx')
CHANGED=$(git -C "$ROOT" status --porcelain -- "${IMAGE_FILES[@]}" | wc -l | tr -d ' ')
LABEL=$SHA
if [ "$CHANGED" -gt 0 ]; then
  [ "$DIRTY_OK" -eq 1 ] ||
    fail "server/, web/ (apart from their tests) or docker-compose.yml differ from $SHA ($CHANGED paths). Commit them, or pass --allow-dirty for a build labelled $SHA-dirty."
  LABEL="$SHA-dirty"
fi
TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

COPIES=("$ROOT")
if [ "$(basename "$ROOT")" = hcml-portal ] && [ -f "$PARENT/hcml-portal-ollama/docker-compose.yml" ]; then
  COPIES+=("$PARENT/hcml-portal-ollama")
fi

say "Build $LABEL, $TIME, for: $(for c in "${COPIES[@]}"; do basename "$c"; done | tr '\n' ' ')"
if [ "$DRY" -eq 1 ]; then say "Dry run: nothing is changed."; fi

if [ "${#COPIES[@]}" -gt 1 ]; then
  say ""
  say "Gate: the two copies hold the same files, apart from the ones meant to differ"
  run node "$ROOT/tools/check/parity.check.mjs"
fi
if [ "$VERIFY" -eq 1 ]; then
  say ""
  say "Gate: npm run verify (typecheck, lint, tests, builds, the checkers)"
  run npm --prefix "$ROOT" run verify
fi

DAY=$(LC_ALL=C date +%d%b | tr '[:upper:]' '[:lower:]' | sed 's/^0//')
# The first rollback-<day><month> tag of this image that is free: rollback-22oct, then rollback-22oct-2.
# It gives up at 50, so a docker that says every tag exists cannot keep the script looping.
free_tag() {
  local tag="rollback-$DAY" n=1
  while [ "$n" -lt 50 ] && docker image inspect "$1:$tag" >/dev/null 2>&1; do
    n=$((n + 1))
    tag="rollback-$DAY-$n"
  done
  printf '%s' "$tag"
}

wait_healthy() {
  local state=missing i
  for i in $(seq 1 60); do
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing)
    if [ "$state" = healthy ]; then return 0; fi
    sleep 3
  done
  say "  $1 is $state after 180 seconds"
  return 1
}

FAILED=0
SIGNIN=''
expect() { # what, wanted, got
  if [ "$2" = "$3" ]; then
    say "  ok    $1 ($3)"
  else
    say "  FAIL  $1: wanted $2, got $3"
    FAILED=1
  fi
}
status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" || true; }

for C in "${COPIES[@]}"; do
  P=$(basename "$C")
  say ""
  say "== $P"
  for IMG in "$P-portal-bff" "$P-portal-web"; do
    if docker image inspect "$IMG:latest" >/dev/null 2>&1; then
      run docker tag "$IMG:latest" "$IMG:$(free_tag "$IMG")"
    else
      say "no $IMG:latest yet, so nothing is kept for a rollback"
    fi
  done
  run env BUILD_COMMIT="$LABEL" BUILD_TIME="$TIME" docker compose --project-directory "$C" up -d --build
  if [ "$DRY" -eq 1 ]; then continue; fi

  say "Waiting for $P to be healthy"
  wait_healthy "$P-portal-bff-1" || FAILED=1
  wait_healthy "$P-portal-web-1" || FAILED=1
  PORT=$(docker port "$P-portal-web-1" 8080/tcp | head -1 | sed 's/.*://')
  BASE="http://127.0.0.1:$PORT"
  say "What an anonymous caller sees at $BASE"
  expect "the health route answers" 200 "$(status_of "$BASE/bff/api/health")"
  expect "the meters are refused" 401 "$(status_of "$BASE/bff/api/net/meters")"
  expect "/.env is not served" 404 "$(status_of "$BASE/.env")"
  expect "/.git/config is not served" 404 "$(status_of "$BASE/.git/config")"
  if curl -sI --max-time 20 "$BASE/" | grep -qi '^content-security-policy:'; then
    say "  ok    the page carries a Content-Security-Policy"
  else
    say "  FAIL  the page carries no Content-Security-Policy"
    FAILED=1
  fi
  say "  bundle: $(curl -s --max-time 20 "$BASE/" | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)"
  say "  build:  $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$P-portal-bff-1" | grep -E '^BUILD_(COMMIT|TIME)=' | tr '\n' ' ')"
  SIGNIN="$SIGNIN
  PORTAL_USER=... PORTAL_PASSWORD=... python3 -I tools/live/signedin_check.py $BASE"
done

if [ "$FAILED" -ne 0 ]; then
  say ""
  say "Something above failed. The images this replaced are tagged rollback-$DAY (setup 23, Rolling back):"
  say "  docker tag <image>:rollback-$DAY <image>:latest, then docker compose up -d --no-build in that copy"
  exit 1
fi

if [ "$LABEL" = "$SHA" ]; then
  TAG="live-$(date +%Y-%m-%d)"
  n=1
  while git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; do
    n=$((n + 1))
    TAG="live-$(date +%Y-%m-%d)-$n"
  done
  say ""
  run git -C "$ROOT" tag -a "$TAG" "$SHA" -m "Live from $TIME: built from $SHA"
  say "The tag is local. To make it public: git push origin $TAG"
fi

say ""
if [ "$DRY" -eq 1 ]; then
  say "Dry run: nothing was changed."
else
  say "Still yours, because it needs a sign-in: open the Dashboard and Problems on each portal, then$SIGNIN"
fi
