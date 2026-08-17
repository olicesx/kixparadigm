#!/usr/bin/env bash
# Restart WSL2 dsh web from /root so sandbox workspaceRoot is not the Windows mount.
set -u
export HOME=/root
echo "== stop existing =="
for pid in $(pgrep -f '^node /usr/local/bin/dsh'); do
  echo "kill $pid"
  kill "$pid" 2>/dev/null || true
done
sleep 2
# leftover?
for pid in $(pgrep -f '^node /usr/local/bin/dsh'); do
  echo "kill -9 $pid"
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1
echo "== start from /root =="
cd /root
setsid nohup dsh web --port 33236 </dev/null > /tmp/dsh-web-p5.log 2>&1 &
sleep 8
echo "== status =="
pgrep -af '^node /usr/local/bin/dsh' || echo PROC-DOWN
ss -tln | grep 33236 && echo LISTENING || echo NOT_LISTEN
curl -s -o /dev/null -w 'inner=%{http_code}\n' --max-time 8 http://127.0.0.1:33236/ || true
echo "== log tail =="
tail -30 /tmp/dsh-web-p5.log || true
