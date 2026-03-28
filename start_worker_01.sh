#!/bin/bash
cd "$(dirname "$0")"
export NODE_ENV=production
export WORKER_NAME=worker_01
export DOTENV_CONFIG_QUIET=true
echo "启动 Worker 1 [worker_01]..."
node worker_main.js
