#!/usr/bin/env bash
# Zhenzhu Miner — cron wrapper.
#
# Hermes runs .js jobs through Python, not node, so every cron entry that calls
# node must go through this wrapper. It also guarantees exit 0 on a clean stop
# so a normal "quota empty" run does not raise an error alert.
#
# Crontab (every 30 minutes):
#   */30 * * * * /home/ubuntu/zhenzhu-miner/run.sh >> /home/ubuntu/zhenzhu-miner/cron.log 2>&1

set -u

DIR="/home/ubuntu/zhenzhu-miner"
NODE="$(command -v node || echo /home/ubuntu/.local/bin/node)"
LOG="$DIR/miner.log"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] cron: run start" >> "$LOG"

"$NODE" "$DIR/miner.js" >> "$LOG" 2>&1
CODE=$?

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] cron: run end exit=$CODE" >> "$LOG"

# 0 is success. Anything else is a real fault worth surfacing, so pass it on.
if [ "$CODE" -ne 0 ]; then
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] cron: FAILED exit=$CODE" >> "$LOG"
  exit "$CODE"
fi

exit 0
