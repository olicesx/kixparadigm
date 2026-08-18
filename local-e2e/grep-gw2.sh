#!/bin/bash
set -u
D=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-gateway
ls "$D" 2>/dev/null
grep -rn 'session.prompt\|"prompt"' "$D"/lib/*.js 2>/dev/null | head -8
echo ==== api-proxy
P=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-proxy
ls "$P"/lib 2>/dev/null | head
grep -rn 'prompt' "$P"/lib/*.js 2>/dev/null | head -8
