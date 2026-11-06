#!/bin/sh
# opencode-to-openai 容器入口
# 首次启动(容器内无 /app/config.json)时按 docker run -e 环境变量生成配置;
# 已有 config.json(如 -v 挂载持久化)则直接使用, 不被 -e 覆盖
# 支持(写入 config.json): PORT API_KEY BIND_HOST DISABLE_TOOLS OPENCODE_PATH OPENCODE_SERVER_URL OPENCODE_BIND_HOST
# 日志等级 LOG_LEVEL(error/warn/info/debug, 不区分大小写)不写入 config.json:
#   由 node 进程直接读取环境变量生效, 优先级高于 config.json 里的 LOG_LEVEL 字段, 未设置时默认 info
set -e

CONFIG=/app/config.json
LOG_LEVEL_DISPLAY="${LOG_LEVEL:-info}"

if [ ! -f "$CONFIG" ]; then
    node -e '
        const fs = require("fs");
        const env = (k, d) => { const v = process.env[k]; return (v === undefined || v === "") ? d : v; };
        const flag = (k, d) => { const v = env(k, d); return v === "true" || v === "1"; };
        const cfg = {
            PORT: parseInt(env("PORT", "8083"), 10),
            API_KEY: env("API_KEY", ""),
            BIND_HOST: env("BIND_HOST", "0.0.0.0"),
            DISABLE_TOOLS: flag("DISABLE_TOOLS", "true"),
            OPENCODE_PATH: env("OPENCODE_PATH", ""),
            OPENCODE_SERVER_URL: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4097"),
            OPENCODE_BIND_HOST: env("OPENCODE_BIND_HOST", "0.0.0.0")
        };
        fs.writeFileSync("/app/config.json", JSON.stringify(cfg, null, 4));
        console.log("[entrypoint] first boot, config generated from env:", JSON.stringify(cfg));
        console.log("[entrypoint] log level (LOG_LEVEL env, higher priority than config.json):", env("LOG_LEVEL", "info"));
    '
else
    echo "[entrypoint] /app/config.json exists, use it as-is (recreate container without the volume to re-apply -e)"
    echo "[entrypoint] log level (LOG_LEVEL env, higher priority than config.json): $LOG_LEVEL_DISPLAY"
fi

exec "$@"
