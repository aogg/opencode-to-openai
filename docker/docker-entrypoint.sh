#!/bin/sh
# opencode-to-openai 容器入口
# 首次启动(容器内无 /app/config.json)时按 docker run -e 环境变量生成配置;
# 已有 config.json(如 -v 挂载持久化)则直接使用, 不被 -e 覆盖
# 支持(写入 config.json): PORT API_KEY BIND_HOST DISABLE_TOOLS OPENCODE_PATH OPENCODE_SERVER_URL OPENCODE_BIND_HOST
#   OPENCODE_AUTO_APPROVE OPENCODE_WORKDIR OPENCODE_STREAM_TOOLS OPENCODE_LOG_TAIL OPENCODE_LOG_FILE
#   OPENCODE_PRINT_LOGS SYSTEM_PROMPT_PATTERNS REQUEST_TIMEOUT_MS OPENCODE_EVENT_IDLE_TIMEOUT_MS OPENCODE_SSE_HEARTBEAT_MS
#   FAST_FAIL_RETRY_MS QUEUE_MAX_WAIT_MS PROGRESS_LOG_INTERVAL_MS STALL_WARN_MS
# 日志等级 LOG_LEVEL(error/warn/info/debug, 不区分大小写)不写入 config.json:
#   由 node 进程直接读取环境变量生效, 优先级高于 config.json 里的 LOG_LEVEL 字段, 未设置时默认 info;
#   CLI --log-level 优先级最高(可用 `docker run ... adockero/opencode-to-openai node index.js --log-level debug` 覆盖 CMD)
set -e

CONFIG=/app/config.json
LOG_LEVEL_DISPLAY="${LOG_LEVEL:-info}"

if [ ! -f "$CONFIG" ]; then
    node -e '
        const fs = require("fs");
        const env = (k, d) => { const v = process.env[k]; return (v === undefined || v === "") ? d : v; };
        const flag = (k, d) => { const v = env(k, d); return v === "true" || v === "1"; };
        const num = (k, d) => { const n = Number(env(k, "")); return Number.isFinite(n) && n > 0 ? n : d; };
        const nonNeg = (k, d) => { const raw = env(k, ""); if (raw === "") return d; const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : d; };
        const cfg = {
            PORT: parseInt(env("PORT", "8083"), 10),
            API_KEY: env("API_KEY", ""),
            BIND_HOST: env("BIND_HOST", "0.0.0.0"),
            DISABLE_TOOLS: flag("DISABLE_TOOLS", "true"),
            OPENCODE_PATH: env("OPENCODE_PATH", ""),
            OPENCODE_SERVER_URL: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4097"),
            OPENCODE_BIND_HOST: env("OPENCODE_BIND_HOST", "0.0.0.0"),
            OPENCODE_AUTO_APPROVE: flag("OPENCODE_AUTO_APPROVE", "true"),
            OPENCODE_WORKDIR: env("OPENCODE_WORKDIR", ""),
            OPENCODE_STREAM_TOOLS: flag("OPENCODE_STREAM_TOOLS", "false"),
            OPENCODE_LOG_TAIL: flag("OPENCODE_LOG_TAIL", "false"),
            OPENCODE_LOG_FILE: env("OPENCODE_LOG_FILE", ""),
            OPENCODE_PRINT_LOGS: flag("OPENCODE_PRINT_LOGS", "false"),
            SYSTEM_PROMPT_PATTERNS: env("SYSTEM_PROMPT_PATTERNS", ""),
            REQUEST_TIMEOUT_MS: num("REQUEST_TIMEOUT_MS", 1800000),
            OPENCODE_EVENT_IDLE_TIMEOUT_MS: num("OPENCODE_EVENT_IDLE_TIMEOUT_MS", 60000),
            OPENCODE_SSE_HEARTBEAT_MS: num("OPENCODE_SSE_HEARTBEAT_MS", 15000),
            FAST_FAIL_RETRY_MS: nonNeg("FAST_FAIL_RETRY_MS", 60000),
            QUEUE_MAX_WAIT_MS: nonNeg("QUEUE_MAX_WAIT_MS", 60000),
            PROGRESS_LOG_INTERVAL_MS: nonNeg("PROGRESS_LOG_INTERVAL_MS", 300000),
            STALL_WARN_MS: nonNeg("STALL_WARN_MS", 300000)
        };
        fs.writeFileSync("/app/config.json", JSON.stringify(cfg, null, 4));
        console.log("[entrypoint] first boot, config generated from env:", JSON.stringify(cfg));
        console.log("[entrypoint] log level (LOG_LEVEL env, higher priority than config.json):", env("LOG_LEVEL", "info"));
    '
else
    echo "[entrypoint] /app/config.json exists, use it as-is (runtime env with the same key still wins over config.json)"
    echo "[entrypoint] log level (LOG_LEVEL env, higher priority than config.json): $LOG_LEVEL_DISPLAY"
fi

exec "$@"
