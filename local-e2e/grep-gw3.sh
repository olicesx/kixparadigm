#!/bin/bash
set -u
D=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib
ls "$D"
echo ====
grep -rln 'prompt' "$D" | head -5
