#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

OUTPUT=${ENV_OUTPUT:-.env}
FORCE=false
ASSUME_DEFAULTS=false
APP_NAME="LLM Hub"
REPOSITORY=nicolaeser/llmhub
COMPOSE_SOURCE=${COMPOSE_SOURCE:-https://raw.githubusercontent.com/$REPOSITORY/main}
BASE_COMPOSE=docker-compose.yml
UPDATER_COMPOSE=docker-compose.au.yml
OVERRIDE_COMPOSE=docker-compose.override.yml
DOWNLOADED_COMPOSE=("$BASE_COMPOSE" "$UPDATER_COMPOSE" docker-compose.rm.yml)
IMAGE_TAG='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
URL_SAFE='^[A-Za-z0-9._~-]+$'
SMTP_PATTERN='^(smtps?)://(([^:@/]*)(:([^@/]*))?@)?([^:@/]+)(:([0-9]+))?/?$'

usage() {
  printf 'Usage: %s [--force] [--yes]\n\n' "$0"
  printf 'Writes the production %s and downloads docker-compose.yml next to it. In a\n' "$OUTPUT"
  printf 'terminal it asks for the domain, release channel, automatic updates, port, mail,\n'
  printf 'single sign-on, object storage, an external redaction model, and error\n'
  printf 'reporting, and it generates every password and secret. With automatic updates it\n'
  printf 'also downloads docker-compose.au.yml and sets COMPOSE_FILE to use both files.\n'
  printf 'It installs curl when neither curl nor wget is available.\n\n'
  printf '  --force  update an existing %s and keep its values\n' "$OUTPUT"
  printf '  --yes    accept every default without asking\n\n'
  printf 'Variables already set in the environment are used as answers;\n'
  printf 'AUTO_UPDATE=yes or AUTO_UPDATE=no answers the automatic updates question.\n'
  printf 'ENV_OUTPUT=path writes somewhere other than %s; the compose files go next to it.\n' "$OUTPUT"
}

for arg in "$@"; do
  case "$arg" in
    -f | --force) FORCE=true ;;
    -y | --yes) ASSUME_DEFAULTS=true ;;
    -h | --help)
      usage
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

COMPOSE_DIR=$(dirname "$OUTPUT")
UPDATER_WAS_ON=false
UPDATER_ON=false
UPDATING=false
if [[ -f $OUTPUT ]]; then
  if [[ $FORCE != true ]]; then
    printf '%s already exists. Run %s --force to update it; its values are kept.\n' "$OUTPUT" "$0" >&2
    exit 1
  fi
  UPDATING=true
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
ANSWER=""

say() { printf '%s\n' "$*" >&2; }
note() {
  if $INTERACTIVE; then say "  ${DIM}$*${RESET}"; fi
}
ok() {
  if $INTERACTIVE; then say "  ${GREEN}✔${RESET} $*"; fi
}
warn() { say "  ${YELLOW}!${RESET} $*"; }
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
set_value() { remember "$1" "$2"; }
hide() { HIDDEN[$1]=1; }
is_hidden() { [[ -v HIDDEN[$1] ]]; }

drop() {
  local key
  for key in "$@"; do
    remember "$key" ""
  done
}

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
    origin) [[ $value =~ ^https?://[^[:space:]/]+$ ]] || { printf 'enter a domain like hub.example.com or an origin like https://hub.example.com (no path)'; return 1; } ;;
    email) [[ $value =~ ^([^<>]*<[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+>|[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+)$ ]] || { printf 'enter an email address, optionally as Name <address>'; return 1; } ;;
    host) [[ $value =~ ^[A-Za-z0-9.-]+$ ]] || { printf 'enter a host name'; return 1; } ;;
    port) [[ $value =~ ^[0-9]+$ ]] && ((value >= 1 && value <= 65535)) || { printf 'enter a port between 1 and 65535'; return 1; } ;;
    int) [[ $value =~ ^[0-9]+$ ]] || { printf 'enter a whole number'; return 1; } ;;
    min:*) ((${#value} >= ${rule#min:})) || { printf 'use at least %s characters' "${rule#min:}"; return 1; } ;;
    regex:*) [[ $value =~ ${rule#regex:} ]] || { printf 'the value has the wrong format'; return 1; } ;;
    *) printf 'unknown rule %s' "$rule"; return 1 ;;
  esac
}

accept() {
  local value=$1 rule message
  shift
  for rule in "$@"; do
    if [[ $rule == to:* ]]; then
      value=$("${rule#to:}" "$value")
    elif ! message=$(validate "$rule" "$value"); then
      printf '%s' "$message"
      return 1
    fi
  done
  printf '%s' "$value"
}

requires_value() {
  local rule
  for rule in "$@"; do
    [[ $rule == required ]] && return 0
  done
  return 1
}

public_origin() {
  local value=$1
  [[ -n $value ]] || return 0
  [[ $value == *://* ]] || value="https://$value"
  while [[ $value == */ ]]; do
    value=${value%/}
  done
  printf '%s' "${value,,}"
}

prompt() {
  local label=$1 value=$2 input result
  shift 2
  while true; do
    read -r -e -i "$value" -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} " input || exit 130
    if result=$(accept "$input" "$@"); then
      ANSWER=$result
      return
    fi
    say "  ${RED}${result}${RESET}"
  done
}

prompt_secret() {
  local label=$1 value=$2 input result hint="hidden, Enter skips"
  shift 2
  if [[ -n $value ]]; then
    hint="hidden, Enter keeps the current value"
  elif requires_value "$@"; then
    hint="hidden"
  fi
  while true; do
    IFS= read -r -s -p "${P_CYAN}?${P_RESET} ${P_BOLD}${label}${P_RESET} ${P_DIM}(${hint})${P_RESET} " input || exit 130
    printf '\n' >&2
    input=${input:-$value}
    if result=$(accept "$input" "$@"); then
      ANSWER=$result
      return
    fi
    say "  ${RED}${result}${RESET}"
  done
}

pick() {
  local label=$1 value=$2 input index name line
  shift 2
  local options=("$@") names=()
  for index in "${!options[@]}"; do
    names+=("${options[$index]%%|*}")
  done
  say "${CYAN}?${RESET} ${BOLD}${label}${RESET}"
  for index in "${!options[@]}"; do
    line=$(printf '%d) %-10s' $((index + 1)) "${names[$index]}")
    if [[ ${names[$index]} == "$value" ]]; then
      say "  ${GREEN}${line}${RESET} ${DIM}${options[$index]#*|}${RESET}"
    else
      say "  ${line} ${DIM}${options[$index]#*|}${RESET}"
    fi
  done
  while true; do
    read -r -e -p "  ${P_DIM}number or name, Enter keeps ${value}${P_RESET} " input || exit 130
    input=${input:-$value}
    if [[ $input =~ ^[0-9]+$ ]] && ((input >= 1 && input <= ${#names[@]})); then
      input=${names[input - 1]}
    fi
    for name in "${names[@]}"; do
      if [[ $name == "$input" ]]; then
        ANSWER=$name
        return
      fi
    done
    say "  ${RED}choose one of: ${names[*]}${RESET}"
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

ask() {
  local key=$1 label=$2 fallback=$3 value result
  shift 3
  value=$(current "$key")
  value=${value:-$fallback}
  if $INTERACTIVE; then
    prompt "$label" "$value" "$@"
    remember "$key" "$ANSWER"
  elif result=$(accept "$value" "$@"); then
    remember "$key" "$result"
  elif [[ -n $value ]]; then
    fail "$key: $result"
  else
    REQUIRED_MISSING+=("$key")
    remember "$key" ""
  fi
}

ask_secret() {
  local key=$1 label=$2 value result
  shift 2
  value=$(current "$key")
  hide "$key"
  if $INTERACTIVE; then
    prompt_secret "$label" "$value" "$@"
    remember "$key" "$ANSWER"
  elif result=$(accept "$value" "$@"); then
    remember "$key" "$result"
  elif [[ -n $value ]]; then
    fail "$key: $result"
  else
    REQUIRED_MISSING+=("$key")
    remember "$key" ""
  fi
}

wanted() {
  local label=$1 key=$2 fallback=n
  [[ -n $(current "$key") ]] && fallback=y
  if $INTERACTIVE; then
    confirm "$label" "$fallback"
  else
    [[ $fallback == y ]]
  fi
}

generated() {
  local key=$1 generator=$2 minimum=${3:-32} value
  value=$(current "$key")
  hide "$key"
  if ((${#value} >= minimum)); then
    ok "$key kept"
  else
    value=$($generator)
    [[ -n $value ]] || fail "could not generate $key"
    ok "$key generated"
  fi
  remember "$key" "$value"
}

random_bytes() { head -c "$1" /dev/urandom; }
gen_hex32() { random_bytes 32 | od -An -v -tx1 | tr -d ' \n'; }
gen_password() { random_bytes 24 | base64 -w0 | tr '+/' '-_' | tr -d '='; }

percent() {
  local LC_ALL=C value=$1 index char
  for ((index = 0; index < ${#value}; index++)); do
    char=${value:index:1}
    if [[ $char == [A-Za-z0-9._~-] ]]; then
      printf '%s' "$char"
    else
      printf '%%%02X' "'$char"
    fi
  done
}

unpercent() { printf '%b' "${1//%/\\x}"; }

latest_release() {
  local response
  if command -v curl >/dev/null; then
    response=$(curl -fsS --max-time 5 "https://api.github.com/repos/$REPOSITORY/releases/latest" 2>/dev/null) || return 0
  elif command -v wget >/dev/null; then
    response=$(wget -qO- -T 5 -t 1 "https://api.github.com/repos/$REPOSITORY/releases/latest" 2>/dev/null) || return 0
  else
    return 0
  fi
  sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' <<<"$response"
}

release_tag() {
  local value channel
  if ! $INTERACTIVE; then
    ask LLMHUB_TAG "Image tag" latest required "regex:$IMAGE_TAG"
    return
  fi
  value=$(current LLMHUB_TAG)
  value=${value:-latest}
  case $value in
    latest | dev) channel=$value ;;
    *) channel=pinned ;;
  esac
  pick "Release channel" "$channel" \
    "latest|stable releases; docker compose pull fetches the newest" \
    "dev|prereleases from the development branch" \
    "pinned|one release tag that changes only when you edit it"
  if [[ $ANSWER == pinned ]]; then
    if [[ $channel != pinned ]]; then
      value=$(latest_release) || value=""
      [[ $value =~ $IMAGE_TAG ]] || value=""
    fi
    note "Release tags are listed at https://github.com/$REPOSITORY/releases"
    prompt "Release tag" "$value" required "regex:$IMAGE_TAG"
  fi
  remember LLMHUB_TAG "$ANSWER"
}

compose_list() {
  local entry entries=()
  IFS=: read -r -a entries <<<"$1"
  for entry in "${entries[@]}"; do
    [[ -n $entry ]] && printf '%s\n' "$entry"
  done
  return 0
}

uses_updater() {
  local entry
  while IFS= read -r entry; do
    [[ $entry == "$UPDATER_COMPOSE" ]] && return 0
  done < <(compose_list "$1")
  return 1
}

updater_default() {
  local previous=$1 answer=${AUTO_UPDATE-}
  case "${answer,,}" in
    y | yes | true | 1 | on) printf 'y' ;;
    n | no | false | 0 | off) printf 'n' ;;
    '')
      if [[ -n $previous ]]; then
        uses_updater "$previous" && printf 'y' || printf 'n'
      elif [[ -f $COMPOSE_DIR/$UPDATER_COMPOSE ]]; then
        printf 'y'
      else
        printf 'n'
      fi
      ;;
    *) return 1 ;;
  esac
}

compose_files() {
  local previous fallback enabled=n entry files=("$BASE_COMPOSE")
  previous=$(current COMPOSE_FILE)
  note "The updater container replaces the app with each new image of the release channel and rolls back when it fails."
  note "It holds the Docker socket, which is root access to this server. It publishes no ports and gets only APP_SECRET."
  if [[ ! $(value_of LLMHUB_TAG) =~ ^(latest|dev)$ ]]; then
    note "A pinned release tag never updates; choose latest or dev to receive updates."
  fi
  fallback=$(updater_default "$previous") || fail "AUTO_UPDATE must be yes or no"
  if confirm "Install the updater (docker-compose.au.yml)?" "$fallback"; then
    enabled=y
    files+=("$UPDATER_COMPOSE")
    note "Turn on automatic installs in Settings → General → Automatic updates after the first start."
  fi
  while IFS= read -r entry; do
    [[ $entry == "$BASE_COMPOSE" || $entry == "$UPDATER_COMPOSE" ]] || files+=("$entry")
  done < <(compose_list "$previous")
  if [[ -z $previous && -f $COMPOSE_DIR/$OVERRIDE_COMPOSE ]]; then
    files+=("$OVERRIDE_COMPOSE")
  fi
  if uses_updater "$previous"; then UPDATER_WAS_ON=true; fi
  if [[ $enabled == y ]]; then UPDATER_ON=true; fi
  local IFS=:
  remember COMPOSE_FILE "${files[*]}"
}

ip_mode() {
  local value
  if ! $INTERACTIVE; then
    ask IP_MODE "Client address source" proxy required "regex:^(proxy|cloudflare|direct)$"
    return
  fi
  value=$(current IP_MODE)
  [[ $value == cloudflare ]] || value=proxy
  note "Sign-in limits, sessions, the audit log, and key IP allowlists use the client address."
  pick "Client address source" "$value" \
    "proxy|the X-Forwarded-For entry the reverse proxy on this server appends" \
    "cloudflare|CF-Connecting-IP; the server accepts web traffic only from Cloudflare"
  remember IP_MODE "$ANSWER"
}

smtp_label() {
  if [[ $1 =~ $SMTP_PATTERN ]]; then
    printf '%s%s' "${BASH_REMATCH[6]}" "${BASH_REMATCH[7]}"
  else
    printf 'the current SMTP URL'
  fi
}

smtp_server() {
  local current=$1 scheme=smtp host="" port="" user="" password="" security next_scheme fallback_port credentials=""
  if [[ $current =~ $SMTP_PATTERN ]]; then
    scheme=${BASH_REMATCH[1]} host=${BASH_REMATCH[6]} port=${BASH_REMATCH[8]}
    user=$(unpercent "${BASH_REMATCH[3]}")
    password=$(unpercent "${BASH_REMATCH[5]}")
  fi
  prompt "SMTP host" "$host" required host
  host=$ANSWER
  security=starttls
  [[ $scheme == smtps ]] && security=tls
  pick "Encryption" "$security" \
    "starttls|STARTTLS, usually port 587" \
    "tls|TLS from the first byte, usually port 465"
  next_scheme=smtp fallback_port=587
  if [[ $ANSWER == tls ]]; then
    next_scheme=smtps fallback_port=465
  fi
  if [[ $next_scheme == "$scheme" && -n $port ]]; then
    fallback_port=$port
  fi
  prompt "SMTP port" "$fallback_port" required port
  port=$ANSWER
  prompt "SMTP user (Enter skips when the server needs no login)" "$user"
  user=$ANSWER
  if [[ -n $user ]]; then
    prompt_secret "SMTP password" "$password" required
    credentials="$(percent "$user"):$(percent "$ANSWER")@"
  fi
  remember SMTP_URL "$next_scheme://$credentials$host:$port"
}

smtp_url() {
  local url
  if ! $INTERACTIVE; then
    ask_secret SMTP_URL "SMTP URL" required "regex:^smtps?://[^[:space:]]+$"
    return
  fi
  url=$(current SMTP_URL)
  hide SMTP_URL
  if [[ -n $url ]] && confirm "Keep sending through $(smtp_label "$url")?" y; then
    remember SMTP_URL "$url"
  else
    smtp_server "$url"
  fi
}

sender_default() {
  local url origin user=""
  url=$(value_of SMTP_URL)
  if [[ $url =~ $SMTP_PATTERN ]]; then
    user=$(unpercent "${BASH_REMATCH[3]}")
  fi
  if [[ $user =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    printf '%s' "$user"
    return
  fi
  origin=$(value_of NEXT_PUBLIC_APP_URL)
  [[ -n $origin ]] && printf 'llmhub@%s' "${origin#*://}"
  return 0
}

preflight() {
  local version
  if version=$(docker compose version --short 2>/dev/null); then
    ok "Docker Compose $version"
  else
    warn "Docker with the Compose plugin was not found. Install it before you start ${APP_NAME}."
  fi
}

install_curl() {
  local sudo=()
  if ((EUID != 0)); then
    command -v sudo >/dev/null || return 1
    sudo=(sudo)
  fi
  say "${DIM}Installing curl to download the compose files.${RESET}"
  if command -v apt-get >/dev/null; then
    "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -qq &&
      "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates
  elif command -v dnf >/dev/null; then
    "${sudo[@]}" dnf install -y -q curl ca-certificates
  elif command -v yum >/dev/null; then
    "${sudo[@]}" yum install -y -q curl ca-certificates
  elif command -v apk >/dev/null; then
    "${sudo[@]}" apk add --no-cache curl ca-certificates
  elif command -v zypper >/dev/null; then
    "${sudo[@]}" zypper --non-interactive --quiet install curl ca-certificates
  elif command -v pacman >/dev/null; then
    "${sudo[@]}" pacman -Sy --noconfirm --needed curl ca-certificates
  else
    return 1
  fi >&2
}

ensure_downloader() {
  if command -v curl >/dev/null || command -v wget >/dev/null; then
    return 0
  fi
  install_curl && command -v curl >/dev/null ||
    fail "Neither curl nor wget is installed, and installing curl failed. Install one of them and run $0 --force."
  ok "curl installed"
}

download() {
  local url=$1 target=$2
  if command -v curl >/dev/null; then
    curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 -o "$target" "$url"
  else
    wget -q -T 60 -t 3 -O "$target" "$url"
  fi
}

managed_compose() {
  local name=$1 known
  for known in "${DOWNLOADED_COMPOSE[@]}"; do
    [[ $known == "$name" ]] && return 0
  done
  return 1
}

fetch_compose() {
  local name=$1 target=$COMPOSE_DIR/$1 tmp
  tmp=$(mktemp "$target.XXXXXX")
  if ! download "$COMPOSE_SOURCE/$name" "$tmp" 2>/dev/null || [[ ! -s $tmp ]]; then
    rm -f "$tmp"
    if [[ -f $target ]]; then
      warn "Could not download $name; the existing file stays."
      return 0
    fi
    fail "Could not download $name from $COMPOSE_SOURCE. $OUTPUT is written; run $0 --force once the server can reach it."
  fi
  chmod 644 "$tmp"
  if [[ ! -f $target ]]; then
    mv "$tmp" "$target"
    say "${GREEN}✔${RESET} Downloaded ${BOLD}$name${RESET}"
  elif cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
    ok "$name is current"
  elif confirm "Replace $name with the current version? The old one is kept as $name.bak" y; then
    cp -p "$target" "$target.bak"
    mv "$tmp" "$target"
    say "${GREEN}✔${RESET} Updated ${BOLD}$name${RESET} (previous version in $name.bak)"
  else
    rm -f "$tmp"
    warn "$name stays as it is."
  fi
}

fetch_compose_files() {
  local entry
  ensure_downloader
  while IFS= read -r entry; do
    if managed_compose "$entry"; then
      fetch_compose "$entry"
    elif [[ ! -f $COMPOSE_DIR/$entry ]]; then
      warn "COMPOSE_FILE lists $entry, which is not in $COMPOSE_DIR."
    fi
  done < <(compose_list "$(value_of COMPOSE_FILE)")
}

database_drift() {
  [[ -d postgres-data ]] || return 0
  local key changed=()
  for key in POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD APP_SECRET; do
    [[ $(existing "$key") == "$(value_of "$key")" ]] || changed+=("$key")
  done
  ((${#changed[@]})) || return 0
  if $UPDATING; then
    warn "./postgres-data already holds a database created with the previous values. Changing ${changed[*]} locks ${APP_NAME} out of it."
  else
    warn "./postgres-data already holds a database, but $OUTPUT is missing. Restore the original $OUTPUT and run with --force; new passwords and a new APP_SECRET lock ${APP_NAME} out of the existing data."
  fi
}

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
  if [[ $value == *$'\n'* ]]; then
    printf '%s' "${DIM}(key, $(wc -l <<<"$value" | tr -d ' ') lines)${RESET}"
  else
    printf '%s' "${DIM}••••••${value: -4}${RESET}"
  fi
}

summary() {
  local entry value
  say ""
  say "${BOLD}Summary${RESET}"
  for entry in "${ORDER[@]}"; do
    if [[ $entry == @* ]]; then
      say "  ${DIM}${entry#@}${RESET}"
      continue
    fi
    value=$(value_of "$entry")
    if [[ -z $value ]]; then
      value="${DIM}(not set)${RESET}"
    elif is_hidden "$entry"; then
      value=$(mask "$value")
    fi
    say "$(printf '    %-21s' "$entry") $value"
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
  local tmp entry value line backup="" unmanaged gap=false wrote=false
  unmanaged=$(unmanaged_lines)
  tmp=$(mktemp "${OUTPUT}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  {
    for entry in "${ORDER[@]}"; do
      if [[ $entry == @* ]]; then
        if $wrote; then gap=true; fi
        continue
      fi
      value=$(value_of "$entry")
      [[ -n $value ]] || continue
      line=$(quote "$value")
      if $gap; then
        printf '\n'
        gap=false
      fi
      printf '%s=%s\n' "$entry" "$line"
      wrote=true
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

next_steps() {
  local origin port host step=1
  origin=$(value_of NEXT_PUBLIC_APP_URL)
  port=$(value_of LLMHUB_PORT)
  host=${origin#*://}
  say ""
  say "${BOLD}Next steps${RESET}"
  if $UPDATING; then
    if $UPDATER_WAS_ON && ! $UPDATER_ON; then
      say "  Apply the changes and remove the updater with ${BOLD}docker compose up -d --remove-orphans${RESET}."
    else
      say "  Apply the changes with ${BOLD}docker compose up -d${RESET}."
    fi
    return
  fi
  say "  $step. Point $host at this server and serve it through a reverse proxy with TLS, for example Caddy:"
  say ""
  say "       $host {"
  say "         reverse_proxy 127.0.0.1:$port {"
  say "           health_uri /internal-api/ready"
  say "           health_interval 2s"
  say "           lb_try_duration 90s"
  say "           lb_try_interval 500ms"
  say "         }"
  say "       }"
  say ""
  if [[ $(value_of IP_MODE) == cloudflare ]]; then
    say "     Accept ports 80 and 443 only from Cloudflare's address ranges, or reach the server through a Cloudflare Tunnel."
    say ""
  fi
  step=$((step + 1))
  say "  $step. Start ${APP_NAME}: ${BOLD}docker compose up -d${RESET}"
  step=$((step + 1))
  say "  $step. Open ${BOLD}$origin/internal-api/setup${RESET} and create the owner account."
  if $UPDATER_ON; then
    step=$((step + 1))
    say "  $step. Turn on ${BOLD}Settings → General → Automatic updates${RESET} if new images should install on their own."
  fi
  say ""
  say "${DIM}Back up $OUTPUT together with the database. Without the same APP_SECRET, stored provider keys and two-factor secrets cannot be read.${RESET}"
}

if $INTERACTIVE; then
  say "${BOLD}${APP_NAME}${RESET} production setup"
  say "${DIM}Writes $OUTPUT and downloads the compose files. Enter accepts the value shown; passwords and secrets are generated.${RESET}"
  if $UPDATING; then
    say "${DIM}Updating the existing $OUTPUT: its values are the defaults, and secrets stay as they are.${RESET}"
  fi
  say ""
  preflight
fi

section "Application"
set_value NODE_ENV production
note "The domain people and applications use. Your reverse proxy serves it with TLS."
ask NEXT_PUBLIC_APP_URL "Domain or public URL" "" to:public_origin required origin https
release_tag
ask LLMHUB_PORT "Port on 127.0.0.1 for the reverse proxy" 3000 required port
ip_mode

section "Automatic updates"
compose_files

section "Database and Redis"
ask POSTGRES_USER "PostgreSQL user" llmhub required "regex:^[A-Za-z_][A-Za-z0-9_]{0,62}$"
ask POSTGRES_DB "PostgreSQL database" llmhub required "regex:^[A-Za-z_][A-Za-z0-9_]{0,62}$"
generated POSTGRES_PASSWORD gen_password 1
[[ $(value_of POSTGRES_PASSWORD) =~ $URL_SAFE ]] || fail "POSTGRES_PASSWORD may hold only letters, digits and . _ ~ - (it is part of DATABASE_URL)"
generated REDIS_PASSWORD gen_password 1
[[ $(value_of REDIS_PASSWORD) =~ $URL_SAFE ]] || fail "REDIS_PASSWORD may hold only letters, digits and . _ ~ - (it is part of REDIS_URL)"

section "Secrets"
generated APP_SECRET gen_hex32 32
note "APP_SECRET encrypts provider keys and two-factor secrets and signs sessions. It must never change."
database_drift

section "Mail"
note "Mail sends password reset links and usage reports. Without it, password reset is off."
if wanted "Send email?" SMTP_URL; then
  smtp_url
  ask SMTP_FROM "Sender address" "$(sender_default)" required email
else
  drop SMTP_URL SMTP_FROM
fi

section "Single sign-on"
note "OpenID Connect is set up in Settings → Sign-in after the first start; only its client secret goes into $OUTPUT."
note "Redirect URI for the identity provider: $(value_of NEXT_PUBLIC_APP_URL)/sso/callback"
if wanted "Add an OpenID Connect client secret?" OIDC_CLIENT_SECRET; then
  ask_secret OIDC_CLIENT_SECRET "Client secret" required
else
  drop OIDC_CLIENT_SECRET
fi

section "Object storage"
note "Without S3, uploads, generated media, and batch files are stored in PostgreSQL."
if wanted "Use S3-compatible object storage?" S3_ACCESS_KEY_ID; then
  ask S3_ACCESS_KEY_ID "Access key ID" "" required "regex:^[^[:space:]]+$"
  ask_secret S3_SECRET_ACCESS_KEY "Secret access key" required
  note "Choose the provider, bucket, region, and endpoint in Settings → Storage."
else
  drop S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
fi

section "Redaction model"
note "docker-compose.rm.yml runs PII-Tracer next to the app and points the app at it without this value."
if wanted "Use a redaction model service that runs elsewhere?" LLMHUB_REDACTOR_URL; then
  ask LLMHUB_REDACTOR_URL "Redaction service URL" "" required url
  note "Choose the detection mode and the model in Guardrails → PII after the first start."
else
  drop LLMHUB_REDACTOR_URL
fi

section "Error reporting"
note "Sentry receives server errors without request bodies, cookies, credentials, or URL parameter values."
ask SENTRY_DSN "Sentry DSN (empty: off)" "" "regex:^(https?://[^[:space:]/]+(/[^[:space:]]*)?)?$"

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
fetch_compose_files
if $INTERACTIVE; then
  next_steps
fi
