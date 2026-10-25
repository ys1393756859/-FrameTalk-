#!/usr/bin/env bash
# 每日备份：pg_dump + restic 增量备份媒体目录与数据库导出
# 宿主机 crontab：0 2 * * * /opt/frametalk/deploy/backup.sh
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_REPO="${BACKUP_REPO:-/mnt/backup/frametalk-restic}"   # NAS / 备份盘上的 restic 仓库
STAMP="$(date +%F)"

# 1. 数据库导出（在容器外生成 SQL）
docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U frametalk -d frametalk > "/tmp/frametalk-db-$STAMP.sql"

# 2. restic 增量备份（媒体目录 + 数据库导出）
export RESTIC_REPOSITORY="$BACKUP_REPO"
restic backup "/tmp/frametalk-db-$STAMP.sql" "${MEDIA_DIR:-/data/media}" \
  --tag daily --tag "$STAMP"

# 3. 保留策略：7 日 + 4 周 + 6 月
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

rm -f "/tmp/frametalk-db-$STAMP.sql"
echo "[$STAMP] backup done -> $BACKUP_REPO"
