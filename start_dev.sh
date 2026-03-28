#!/bin/bash
cd "$(dirname "$0")"
export NODE_ENV=development
export WORKER_NAME=worker_dev
export DOTENV_CONFIG_QUIET=true
echo "启动 Worker [development]..."
node worker_main.js
