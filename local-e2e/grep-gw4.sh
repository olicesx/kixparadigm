#!/bin/bash
set -u
# find where /api/<name> routes are dispatched (web server side)
H=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app
grep -rn 'api/' "$H"/lib/*.js 2>/dev/null | grep -i 'prompt\|route\|dispatch' | head -10
echo ==== find http server
grep -rln 'createServer\|listen(' "$H"/lib/*.js 2>/dev/null | head -5
