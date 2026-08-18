#!/bin/bash
# Direct session.prompt via the web API (GUI socket pool was poisoned by the
# command-palette poll loop; the server itself is healthy).
set -euo pipefail
RPC=$(cat /proc/sys/kernel/random/uuid)
cat > /tmp/prompt-body.json <<EOF
{"type":"client-request","rpcId":"$RPC","method":"session.prompt","payload":{"sessionId":"session-90b43436-8c70-4d4a-88c9-786b89ad0660","mode":"queue","content":[{"type":"text","text":"现在做 v5.10 子代理验收(用户明确指令,严格照做)。只做一件事:用 subagent 工具分派一个子代理(run_in_background 默认即可),description 写 \"v5.10 child surface E2E\",prompt 原文如下:\"依次执行 9 步,每步一个工具调用:第 1-8 步用 bash 依次 cat /root/kix-budget-e2e/big01.txt 到 big08.txt,每步记录输出末行的 ENDMARK-NN-TAIL 标记(截断输出会保留尾部,直接可见);第 9 步尝试调用 subagent_cross 工具一次(参数 description 随意、prompt 写 'test'),如实记录它的报错原文。最后 report:8 个 ENDMARK 清单 + 第 9 步的报错原文。\" 等子代理完成后,原样转述它的 report(含报错原文)。不要自己做 cat,不要修改任何文件。"}],"clientTimeZone":"Asia/Shanghai"}}
EOF
curl -s -X POST http://127.0.0.1:33236/api/session.prompt \
  -H 'Content-Type: application/json' \
  --data @/tmp/prompt-body.json --max-time 20 | head -c 400
echo
echo PROMPT-SENT
