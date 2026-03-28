#!/bin/bash
cd "$(dirname "$0")"
export NODE_ENV=production
export WORKER_NAME=worker_02
export DOTENV_CONFIG_QUIET=true
echo "启动 Worker 2 [worker_02]..."
node worker_main.js
