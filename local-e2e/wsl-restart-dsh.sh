#!/usr/bin/env bash
# WSL2 dsh web 重启（从 /root 起始，setsid 脱离；避免 pkill 自匹配用精确匹配）
set -u
for pid in $(pgrep -f '^node /usr/local/bin/dsh'); do kill "$pid" 2>/dev/null; done
sleep 2
cd /root
setsid nohup dsh --profile web --port 33236 </dev/null > /tmp/dsh-web-v129.log 2>&1 &
sleep 7
pgrep -f '^node /usr/local/bin/dsh' && echo PROC-UP
ss -tln | grep -q 33236 && echo LISTENING
curl -s -o /dev/null -w 'inner=%{http_code}\n' --max-time 8 http://127.0.0.1:33236/
rm -rf /root/kix-discipline /root/kix-v129-e2e/kix-discipline
