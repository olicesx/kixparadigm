#!/bin/bash
set -u
G=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js
grep -n 'prompt' "$G" | head -10
echo ----
grep -n 'parseBody\|json()\|req.body\|readBody' "$G" | head -10
