#!/bin/bash
# Weekly userAssets backup — runs every Sunday 08:00
DATE=$(date +%Y-%m-%d)
OUTDIR="/root/tradesnow/backups"
mkdir -p "$OUTDIR"

MYSQL_OPTS="-u tradesnow -pTsV2026_LocalDb -h 127.0.0.1 tradesnow"

# CSV export
mysql $MYSQL_OPTS --batch --silent -e "
SELECT id, userId, ticker, exchange, companyName, sector, score, label,
       recommendation, tier, mentorSources, mentorConfidence, signalBias,
       hotSignal, archived, createdAt
FROM userAssets
WHERE archived = 0
ORDER BY ticker
" 2>/dev/null | sed 's/\t/,/g' > "$OUTDIR/userAssets_$DATE.csv"

# Add CSV header
HEADER="id,userId,ticker,exchange,companyName,sector,score,label,recommendation,tier,mentorSources,mentorConfidence,signalBias,hotSignal,archived,createdAt"
TMPF=$(mktemp)
echo "$HEADER" > "$TMPF"
cat "$OUTDIR/userAssets_$DATE.csv" >> "$TMPF"
mv "$TMPF" "$OUTDIR/userAssets_$DATE.csv"

# SQL dump
mysqldump -u tradesnow -pTsV2026_LocalDb -h 127.0.0.1 \
  --no-tablespaces --single-transaction \
  tradesnow userAssets > "$OUTDIR/userAssets_$DATE.sql" 2>/dev/null

# Keep only last 8 backups of each type
ls -t "$OUTDIR"/userAssets_*.csv 2>/dev/null | tail -n +9 | xargs rm -f
ls -t "$OUTDIR"/userAssets_*.sql 2>/dev/null | tail -n +9 | xargs rm -f

CSV_SIZE=$(du -sh "$OUTDIR/userAssets_$DATE.csv" 2>/dev/null | cut -f1)
SQL_SIZE=$(du -sh "$OUTDIR/userAssets_$DATE.sql" 2>/dev/null | cut -f1)
ROWS=$(wc -l < "$OUTDIR/userAssets_$DATE.csv")

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Weekly backup done — $DATE | CSV: $CSV_SIZE ($ROWS rows) | SQL: $SQL_SIZE" >> /root/tradesnow/backups/backup.log
echo "OK: $DATE CSV=$CSV_SIZE SQL=$SQL_SIZE ROWS=$ROWS"
