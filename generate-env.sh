#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

OUTPUT=${ENV_OUTPUT:-.env}
FORCE=false
ASSUME_DEFAULTS=false
APP_NAME="LLM Hub"

for arg in "$@"; do
  case "$arg" in
    -f | --force) FORCE=true ;;
    -y | --yes) ASSUME_DEFAULTS=true ;;
    -h | --help)
      printf 'Usage: %s [--force] [--yes]\n\n' "$0"
      printf '  --force  regenerate an existing %s and keep its values\n' "$OUTPUT"
      printf '  --yes    accept every default without asking\n\n'
      printf 'Variables already set in the environment are used as answers.\n'
      printf 'ENV_OUTPUT=path writes somewhere other than %s.\n' "$OUTPUT"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

if ((BASH_VERSINFO[0] < 5)); then
  printf 'bash 5 or newer is required (found %s).\n' "$BASH_VERSION" >&2
  exit 1
fi

if [[ -f $OUTPUT && $FORCE != true ]]; then
  printf '%s already exists. Run with --force to regenerate it and keep its values.\n' "$OUTPUT" >&2
  exit 1
fi

INTERACTIVE=false
if [[ -t 0 && $ASSUME_DEFAULTS != true ]]; then
  INTERACTIVE=true
fi

if [[ -t 2 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' CYAN=$'\e[36m' RESET=$'\e[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi
P_BOLD=$'\001'$BOLD$'\002' P_DIM=$'\001'$DIM$'\002' P_CYAN=$'\001'$CYAN$'\002' P_RESET=$'\001'$RESET$'\002'

declare -A VALUES=()
declare -A HIDDEN=()
ORDER=()
REQUIRED_MISSING=()

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "${RED}✖${RESET} $*"
  exit 1
}

existing() {
  [[ -f $OUTPUT ]] || return 0
  local line
  line=$(grep -E "^$1=" "$OUTPUT" | tail -n 1) || return 0
  line=${line#*=}
  if [[ $line == \"*\" && ${#line} -ge 2 ]]; then
    line=${line:1:${#line}-2}
    line=${line//\\n/$'\n'}
    line=${line//\\\"/\"}
    line=${line//\\\\/\\}
  elif [[ $line == \'*\' && ${#line} -ge 2 ]]; then
    line=${line:1:${#line}-2}
  fi
  printf '%s' "$line"
}

current() {
  local key=$1
  if [[ -n ${!key-} ]]; then
    printf '%s' "${!key}"
  else
    existing "$key"
  fi
}

remember() {
  [[ -v VALUES[$1] ]] || ORDER+=("$1")
  VALUES[$1]=$2
}

value_of() { printf '%s' "${VALUES[$1]-}"; }
hide() { HIDDEN[$1]=1; }
is_hidden() { [[ -v HIDDEN[$1] ]]; }

section() {
  ORDER+=("@$1")
  if $INTERACTIVE; then
    say ""
    say "${BOLD}$1${RESET}"
  fi
}

validate() {
  local rule=$1 value=$2
  case "$rule" in
    '' | optional) return 0 ;;
    required) [[ -n $value ]] || { printf 'a value is required'; return 1; } ;;
    url) [[ $value =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || { printf 'enter a URL like https://example.com'; return 1; } ;;
    https) [[ $value =~ ^https://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || { printf 'enter an https:// URL'; return 1; } ;;
    origin) [[ $value =~ ^https?://[^[:space:]/]+$ ]] || { printf 'enter an origin like https://example.com (no path, no trailing slash)'; return 1; } ;;
    email) [[ $value =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { printf 'enter an email address'; return 1; } ;;
    host) [[ $value =~ ^[A-Za-z0-9.-]+$ ]] || { printf 'enter a host name'; return 1; } ;;
    port) [[ $value =~ ^[0-9]+$ ]] && ((value >= 1 && value <= 65535)) || { printf 'enter a port between 1 and 65535'; return 1; } ;;
    int) [[ $value =~ ^[0-9]+$ ]] || { printf 'enter a whole number'; return 1; } ;;
    min:*) ((${#value} >= ${rule#min:})) || { printf 'use at least %s characters' "${rule#min:}"; return 1; } ;;
    regex:*) [[ $value =~ ${rule#regex:} ]] || { printf 'the value has the wrong format'; return 1; } ;;
    *) printf 'unknown rule %s' "$rule"; return 1 ;;
  esac
}

check_all() {
  local value=$1 rule message
  shift
  for rule in "$@"; do
    if ! message=$(validate "$rule" "$value"); then
      printf '%s' "$message"
      return 1
    fi
  done
}

ask() {
  local key=$1 label=$2 fallback=${3-} value input message
  shift 3 || shift $#
  local rules=("$@")
  value=$(current "$key")
  value=${value:-$fallback}
  if ! $INTERACTIVE; then
    if message=$(check_all "$value" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$value"
      return
    fi
    [[ -z $value ]] && REQUIRED_MISSING+=("$key")
    [[ -n $value ]] && fail "$key: $message"
    remember "$key" "$value"
    return
  fi
  while true; do
    read -r -e -i "$value" -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} " input || exit 130
    if message=$(check_all "$input" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$input"
      return
    fi
    say "  ${RED}${message}${RESET}"
  done
}

ask_secret() {
  local key=$1 label=$2 value input message hint
  shift 2
  local rules=("$@")
  value=$(current "$key")
  hide "$key"
  if ! $INTERACTIVE; then
    if message=$(check_all "$value" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$value"
      return
    fi
    [[ -z $value ]] && REQUIRED_MISSING+=("$key")
    [[ -n $value ]] && fail "$key: $message"
    remember "$key" "$value"
    return
  fi
  hint="leave empty to skip"
  [[ -n $value ]] && hint="leave empty to keep the current value"
  while true; do
    read -r -s -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} ${P_DIM}(${hint})${P_RESET} " input || exit 130
    printf '\n' >&2
    input=${input:-$value}
    if message=$(check_all "$input" ${rules[@]+"${rules[@]}"}); then
      remember "$key" "$input"
      return
    fi
    say "  ${RED}${message}${RESET}"
  done
}

choose() {
  local key=$1 label=$2 fallback=$3 value input index option
  shift 3
  local options=("$@")
  value=$(current "$key")
  value=${value:-$fallback}
  if ! $INTERACTIVE; then
    for option in "${options[@]}"; do
      if [[ $option == "$value" ]]; then
        remember "$key" "$value"
        return
      fi
    done
    fail "$key must be one of: ${options[*]}"
  fi
  say "${CYAN}?${RESET} ${BOLD}${label}${RESET}"
  for index in "${!options[@]}"; do
    if [[ ${options[$index]} == "$value" ]]; then
      say "  ${GREEN}$((index + 1))) ${options[$index]}${RESET} ${DIM}(current)${RESET}"
    else
      say "  $((index + 1))) ${options[$index]}"
    fi
  done
  while true; do
    read -r -e -p "  ${P_DIM}number or name, Enter keeps ${value}${P_RESET} " input || exit 130
    input=${input:-$value}
    if [[ $input =~ ^[0-9]+$ ]] && ((input >= 1 && input <= ${#options[@]})); then
      input=${options[$((input - 1))]}
    fi
    for option in "${options[@]}"; do
      if [[ $option == "$input" ]]; then
        remember "$key" "$input"
        return
      fi
    done
    say "  ${RED}choose one of: ${options[*]}${RESET}"
  done
}

confirm() {
  local label=$1 fallback=${2:-y} input
  if ! $INTERACTIVE; then
    [[ $fallback == y ]]
    return
  fi
  local shown="Y/n"
  [[ $fallback == n ]] && shown="y/N"
  while true; do
    read -r -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} ${P_DIM}(${shown})${P_RESET} " input || exit 130
    input=${input:-$fallback}
    case "${input,,}" in
      y | yes | j | ja) return 0 ;;
      n | no | nein) return 1 ;;
    esac
  done
}

set_value() { remember "$1" "$2"; }

keep_or() {
  local key=$1 value
  value=$(current "$key")
  remember "$key" "${value:-$2}"
}

generated() {
  local key=$1 generator=$2 minimum=${3:-32} value
  value=$(current "$key")
  hide "$key"
  if ((${#value} < minimum)); then
    value=$($generator)
    [[ -n $value ]] || fail "could not generate $key"
  fi
  remember "$key" "$value"
}

random_bytes() { head -c "$1" /dev/urandom; }
gen_hex32() { random_bytes 32 | od -An -v -tx1 | tr -d ' \n'; }
gen_password() { random_bytes 24 | base64 -w0 | tr '+/' '-_' | tr -d '='; }

quote() {
  local value=$1
  if [[ $value == *$'\n'* ]]; then
    [[ $value == *\$* || $value == *\'* ]] && fail "multi-line values must not contain \$ or '"
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//$'\n'/\\n}
    printf '"%s"' "$value"
  elif [[ $value =~ ^[A-Za-z0-9_./:@?=\&%+,~-]*$ ]]; then
    printf '%s' "$value"
  elif [[ $value == *\'* ]]; then
    fail "values must not contain single quotes"
  else
    printf "'%s'" "$value"
  fi
}

mask() {
  local value=$1
  if [[ -z $value ]]; then
    printf '%s' "${DIM}(empty)${RESET}"
  elif [[ $value == *$'\n'* ]]; then
    printf '%s' "${DIM}(key, $(wc -l <<<"$value" | tr -d ' ') lines)${RESET}"
  else
    printf '%s' "${DIM}••••••${value: -4}${RESET}"
  fi
}

summary() {
  local entry
  say ""
  say "${BOLD}Summary${RESET}"
  for entry in "${ORDER[@]}"; do
    [[ $entry == @* ]] && continue
    if is_hidden "$entry"; then
      say "  ${entry} = $(mask "$(value_of "$entry")")"
    else
      local shown
      shown=$(value_of "$entry")
      say "  ${entry} = ${shown:-${DIM}(empty)${RESET}}"
    fi
  done
}

unmanaged_lines() {
  [[ -f $OUTPUT ]] || return 0
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    [[ -v VALUES[${BASH_REMATCH[1]}] ]] && continue
    printf '%s\n' "$line"
  done <"$OUTPUT"
}

write_env() {
  local tmp entry separator="" backup="" unmanaged
  unmanaged=$(unmanaged_lines)
  tmp=$(mktemp "${OUTPUT}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  {
    for entry in "${ORDER[@]}"; do
      if [[ $entry == @* ]]; then
        printf '%s' "$separator"
        separator=$'\n'
        continue
      fi
      printf '%s=%s\n' "$entry" "$(quote "$(value_of "$entry")")"
    done
    if [[ -n $unmanaged ]]; then
      printf '\n%s\n' "$unmanaged"
    fi
  } >"$tmp"
  if [[ -n $unmanaged ]]; then
    say "${DIM}Kept $(wc -l <<<"$unmanaged" | tr -d ' ') variable(s) this script does not manage.${RESET}"
  fi
  chmod 600 "$tmp"
  if [[ -f $OUTPUT ]]; then
    cp -p "$OUTPUT" "$OUTPUT.bak"
    chmod 600 "$OUTPUT.bak"
    backup=" (previous version in $OUTPUT.bak)"
  fi
  mv "$tmp" "$OUTPUT"
  trap - EXIT
  say "${GREEN}✔${RESET} Wrote ${BOLD}$OUTPUT${RESET}$backup"
}

if $INTERACTIVE; then
  say "${BOLD}${APP_NAME}${RESET} production environment"
  say "${DIM}Enter accepts the value shown. Secrets are generated automatically.${RESET}"
fi

URL_SAFE='^[A-Za-z0-9._~-]+$'

section "Application"
set_value NODE_ENV production
ask LLMHUB_TAG "Image tag (ghcr.io/nicolaeser/llmhub)" latest required "regex:^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$"
ask NEXT_PUBLIC_APP_URL "Public URL" "" required origin https
ask LLMHUB_PORT "Port on 127.0.0.1 for the reverse proxy" 3000 required port

section "Database and Redis"
ask POSTGRES_USER "PostgreSQL user" llmhub required "regex:^[A-Za-z_][A-Za-z0-9_]{0,62}$"
ask POSTGRES_DB "PostgreSQL database" llmhub required "regex:^[A-Za-z_][A-Za-z0-9_]{0,62}$"
generated POSTGRES_PASSWORD gen_password 1
[[ $(value_of POSTGRES_PASSWORD) =~ $URL_SAFE ]] || fail "POSTGRES_PASSWORD may hold only letters, digits and . _ ~ - (it is part of DATABASE_URL)"
generated REDIS_PASSWORD gen_password 1
[[ $(value_of REDIS_PASSWORD) =~ $URL_SAFE ]] || fail "REDIS_PASSWORD may hold only letters, digits and . _ ~ - (it is part of REDIS_URL)"

section "Secrets"
generated APP_SECRET gen_hex32 32

section "Mail"
ask_secret SMTP_URL "SMTP URL for password resets and usage reports, smtp://user:password@host:587 (optional)" "regex:^(smtps?://[^[:space:]]+)?$"
if [[ -n $(value_of SMTP_URL) ]]; then
  ask SMTP_FROM "Sender address" "" required email
fi

section "Single sign-on"
ask_secret OIDC_CLIENT_SECRET "OpenID Connect client secret (optional; issuer and client ID live in Admin settings)" optional

section "Object storage"
ask S3_ACCESS_KEY_ID "S3 access key ID (optional; without S3, files are stored in PostgreSQL)" "" "regex:^[^[:space:]]*$"
if [[ -n $(value_of S3_ACCESS_KEY_ID) ]]; then
  ask_secret S3_SECRET_ACCESS_KEY "S3 secret access key" required
fi

summary
if [[ ${#REQUIRED_MISSING[@]} -gt 0 ]]; then
  say ""
  fail "Missing required values: ${REQUIRED_MISSING[*]}. Set them in the environment or run without --yes."
fi
if $INTERACTIVE && ! confirm "Write $OUTPUT?" y; then
  say "Nothing written."
  exit 1
fi
write_env
