#!/usr/bin/env bash
# Daily backup of Tendly's state directory (~/.tendly).
#
#   backup.sh                 make today's backup, drop the ones past their days
#   backup.sh --check DIR     verify the databases inside one backup folder
#
# What it does:
#   1. Copies the state directory into <dest>/<YYYY-MM-DD>/ with rsync. Files
#      that did not change since the previous backup are hard links to it, so
#      fourteen days cost little more than one.
#   2. Copies every database (tendly.db, hub.db, tendly-metrics.db) with
#      SQLite's online backup (`sqlite3 .backup`), which is safe while the
#      server is running, and checks each copy with PRAGMA integrity_check.
#      The live -wal/-shm files are never copied.
#   3. Deletes dated folders older than the number of days kept (14).
#   4. Optionally sends the new folder to a restic repository, off the machine.
#
# Settings, all optional, from the environment (deploy/install.md puts them in
# /etc/tendly/backup.env):
#   TENDLY_STATE_DIR          what to back up            default: ~/.tendly
#   TENDLY_BACKUP_DIR         where the dated folders go default: ~/backups/tendly
#   TENDLY_BACKUP_KEEP_DAYS   days of folders to keep    default: 14
#   RESTIC_REPOSITORY         set it to also run restic (sftp:, s3:, b2:, rest:, a path...)
#   RESTIC_PASSWORD_FILE      or RESTIC_PASSWORD: the repository's password
#   TENDLY_RESTIC_KEEP_DAILY  restic snapshots kept, one per day   default: 14
#   TENDLY_RESTIC_KEEP_WEEKLY restic snapshots kept, one per week  default: 8
#   (plus whatever the restic backend itself reads: AWS_ACCESS_KEY_ID, B2_ACCOUNT_ID...)
#
# A backup holds everything the server holds: conversations, the keys of the
# signed-in accounts, the push key. Folders are created 0700. Keep the restic
# password somewhere that is NOT this server.
#
# Exit status: 0 only when the local backup is complete and verified (and the
# restic run, if asked for, worked). Nothing old is deleted after a failure.

set -euo pipefail
umask 077

say() { printf '%s\n' "$*"; }
fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "\"$1\" is not installed (sudo apt install $2)"; }

# Runs PRAGMA integrity_check on every database in a backup folder.
check_folder() {
  local folder=$1 found=0 database result
  [ -d "$folder" ] || fail "no such backup folder: $folder"
  for database in "$folder"/*.db; do
    [ -f "$database" ] || continue
    found=1
    result=$(sqlite3 "$database" 'PRAGMA integrity_check;' 2>&1) || fail "cannot read $database: $result"
    [ "$result" = "ok" ] || fail "$database is damaged: $result"
    say "  ok  $(basename "$database")"
  done
  [ "$found" = 1 ] || fail "no database in $folder: this is not a Tendly backup"
}

if [ "${1:-}" = "--check" ]; then
  [ -n "${2:-}" ] || fail "usage: backup.sh --check <backup folder>"
  need sqlite3 sqlite3
  check_folder "$2"
  exit 0
fi
[ $# -eq 0 ] || fail "usage: backup.sh [--check <backup folder>]"

STATE=${TENDLY_STATE_DIR:-$HOME/.tendly}
DEST=${TENDLY_BACKUP_DIR:-$HOME/backups/tendly}
KEEP_DAYS=${TENDLY_BACKUP_KEEP_DAYS:-14}

need sqlite3 sqlite3
need rsync rsync
[ -d "$STATE" ] || fail "no state directory at $STATE (set TENDLY_STATE_DIR)"
[ -f "$STATE/tendly.db" ] || fail "$STATE has no tendly.db: refusing to back up something that is not Tendly's state"
case "$KEEP_DAYS" in ''|*[!0-9]*) fail "TENDLY_BACKUP_KEEP_DAYS must be a number of days, not \"$KEEP_DAYS\"" ;; esac
[ "$KEEP_DAYS" -ge 1 ] || fail "TENDLY_BACKUP_KEEP_DAYS must be at least 1"

# The state directory must not contain the destination, or each backup would
# swallow the ones before it.
STATE=$(cd "$STATE" && pwd -P)
mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd -P)
case "$DEST/" in "$STATE"/*) fail "the backup folder ($DEST) is inside the state directory ($STATE); choose another TENDLY_BACKUP_DIR" ;; esac
chmod 700 "$DEST"

today=$(date -u +%Y-%m-%d)
target=$DEST/$today
partial=$DEST/.partial-$today

# The newest finished backup, to hard-link unchanged files against.
previous=
for folder in "$DEST"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  if [ -d "$folder" ]; then previous=$folder; fi
done

# What an interrupted run left half made, today or on an earlier day.
rm -rf "$DEST"/.partial-*
mkdir -p "$partial"
trap 'rm -rf "$partial"' EXIT

say "Backing up $STATE to $target"

# 1. Files. Databases come next, by SQLite itself; the rest of what is left
#    out only means something to the running process.
link=()
if [ -n "$previous" ]; then link=(--link-dest="$previous"); fi
rsync -a ${link[@]+"${link[@]}"} \
  --exclude='/*.db' --exclude='/*.db-wal' --exclude='/*.db-shm' --exclude='/*.db-journal' \
  --exclude='/*.lock' --exclude='/tendly.pid' --exclude='/tendly.log' --exclude='/tendly.log.*' \
  --exclude='/pty/' --exclude='/native-bridge/' \
  "$STATE"/ "$partial"/

# 2. Databases, consistent even while the server writes to them.
for database in "$STATE"/*.db; do
  [ -f "$database" ] || continue
  name=$(basename "$database")
  sqlite3 "$database" ".timeout 20000" ".backup '$partial/$name'" || fail "could not copy $name"
  [ -s "$partial/$name" ] || fail "the copy of $name is missing or empty"
done
check_folder "$partial"

{
  say "Tendly backup"
  say "made:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "host:  $(hostname)"
  say "from:  $STATE"
  say "size:  $(du -sh "$partial" | cut -f1)"
  say "restore: deploy/install.md, \"Restaurar um backup\""
} > "$partial/BACKUP.txt"

# A second run on the same day replaces that day's folder, only now that the
# new one is whole.
if [ -d "$target" ]; then
  rm -rf "$DEST/.replaced-$today"
  mv "$target" "$DEST/.replaced-$today"
fi
mv "$partial" "$target"
rm -rf "$DEST/.replaced-$today"
trap - EXIT
say "Done: $target ($(du -sh "$target" | cut -f1))"

# 3. Old folders. Names sort as dates, so anything before the cutoff goes.
cutoff=$(date -u -d "$KEEP_DAYS days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${KEEP_DAYS}"d +%Y-%m-%d)
for folder in "$DEST"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [ -d "$folder" ] || continue
  name=$(basename "$folder")
  if [ "$name" \< "$cutoff" ] && [ "$folder" != "$target" ]; then
    rm -rf "$folder"
    say "Removed $name (older than $KEEP_DAYS days)"
  fi
done

# 4. Off the machine, when a restic repository is configured.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  command -v restic >/dev/null 2>&1 || fail "RESTIC_REPOSITORY is set but restic is not installed (sudo apt install restic). The local backup above is complete."
  [ -n "${RESTIC_PASSWORD_FILE:-}${RESTIC_PASSWORD:-}${RESTIC_PASSWORD_COMMAND:-}" ] || fail "RESTIC_REPOSITORY is set but no password: set RESTIC_PASSWORD_FILE. The local backup above is complete."
  restic cat config >/dev/null 2>&1 || fail "the restic repository cannot be opened. If it is new, run \"restic init\" once with the same settings. The local backup above is complete."
  say "Sending to the restic repository"
  restic backup --quiet --tag tendly --host "$(hostname)" "$target"
  restic forget --quiet --tag tendly --group-by host,tags \
    --keep-daily "${TENDLY_RESTIC_KEEP_DAILY:-14}" --keep-weekly "${TENDLY_RESTIC_KEEP_WEEKLY:-8}" --prune
  say "Sent."
fi
