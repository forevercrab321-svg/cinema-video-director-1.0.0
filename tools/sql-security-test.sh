#!/usr/bin/env bash
# Backend security regression test (audit 2026-09-30: C1 M1 M2 L1 L2).
#
# Spins up a throw-away Postgres cluster, loads a minimal Supabase stand-in (roles anon /
# authenticated / service_role, auth.users, auth.uid() from request.jwt.claim.sub, Supabase's
# default grants), applies supabase/migrations 0001 → 0007 (0005, 0006 and 0007 twice: idempotent),
# then:
#   1. supabase/tests/lobby.sql            — the lobby sanity checks (normal flows + clamping)
#   2. tools/sql-security/exploits.sql     — every audit exploit must fail, normal flows must work
#   3. tools/sql-security/submit-match-test.mjs — the real edge function (supabase/functions/
#      submit-match/index.ts) under Node with a mock supabase-js that forwards rpc() to this DB.
#
# Usage: tools/sql-security-test.sh        (needs Postgres ≥ 14 server binaries and Node ≥ 22.6)
#        PG_BIN=/usr/lib/postgresql/16/bin tools/sql-security-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/tools/sql-security"

if [ -z "${PG_BIN:-}" ]; then
  if [ -x "$(command -v pg_ctl || true)" ]; then PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else PG_BIN="$(ls -d /usr/lib/postgresql/*/bin /usr/local/opt/postgresql*/bin 2>/dev/null | sort -V | tail -1 || true)"; fi
fi
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found (set PG_BIN)"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sqlsec.XXXXXX")"
PGDATA="$WORK/data"
SOCK="$WORK/sock"
PORT="${PGPORT_TEST:-55439}"
mkdir -p "$SOCK"

# Postgres refuses to run as root: use the postgres account when we are root.
AS=()
if [ "$(id -u)" = 0 ]; then
  id postgres >/dev/null 2>&1 || { echo "running as root needs a 'postgres' user"; exit 2; }
  chown -R postgres "$WORK"
  chmod 755 "$WORK"
  AS=(runuser -u postgres --)
fi

cleanup() {
  "${AS[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${AS[@]}" "$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust --no-sync -E UTF8 --locale=C >/dev/null
"${AS[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$WORK/pg.log" -w \
  -o "-c listen_addresses='' -k $SOCK -p $PORT -c fsync=off" start >/dev/null

export PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
# Migrations print "does not exist, skipping" notices on a fresh database: hide them.
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

step() { printf '\n── %s\n' "$*"; }

step "Supabase stand-in"
"${PSQL[@]}" -f "$HERE/stub.sql"

step "Migrations 0001 → 0004 (production state before this change)"
for f in 0001_init 0002_products_seed 0003_players_row_on_signup 0004_lobby_presence; do
  "${PSQL[@]}" -f "$ROOT/supabase/migrations/$f.sql"
  echo "  applied $f"
done

step "Pre-0005 data an attacker could already have written (must not break 0005)"
"${PSQL[@]}" -c "insert into auth.users (id) values ('99999999-9999-9999-9999-999999999999');
  update public.players set equipped = '{\"skin\":\"x\",\"junk\":{\"deep\":[1,2,3]}}' where id = '99999999-9999-9999-9999-999999999999';"

step "Migration 0005 (twice: idempotent)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0005_security_hardening.sql"
echo "  applied 0005"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0005_security_hardening.sql"
echo "  applied 0005 again"

step "Migration 0006 (twice: idempotent)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0006_room_host.sql"
echo "  applied 0006"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0006_room_host.sql"
echo "  applied 0006 again"

step "Migration 0007 (twice: idempotent)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0007_six_player_rooms.sql"
echo "  applied 0007"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0007_six_player_rooms.sql"
echo "  applied 0007 again"

step "supabase/tests/lobby.sql"
"${PSQL[@]}" -t -f "$ROOT/supabase/tests/lobby.sql" | grep -E 'passed' | sed 's/^ */  /'

step "tools/sql-security/exploits.sql"
PGOPTIONS="-c client_min_messages=notice" "${PSQL[@]}" -t -f "$HERE/exploits.sql" 2>&1 | sed -n -e 's/^.*NOTICE:  /  /p' -e '/ERROR/p'

step "tools/sql-security/room-host.sql (0006: server-confirmed room host)"
PGOPTIONS="-c client_min_messages=notice" "${PSQL[@]}" -t -f "$HERE/room-host.sql" 2>&1 | sed -n -e 's/^.*NOTICE:  /  /p' -e '/ERROR/p' -e 's/^ *\(room-host.sql: .*\)/  \1/p'

step "submit-match edge function (node mock → this database)"
node "$HERE/submit-match-test.mjs"

printf '\nALL SECURITY CHECKS PASSED\n'
