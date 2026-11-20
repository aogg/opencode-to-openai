import { startProxy } from './src/proxy.js';
import { logger } from './src/logger.js';
import { parseCliArgs, resolveLogLevelSettings, resolvePatternsSetting, usageText } from './src/cli.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    }
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

/** 正数解析: 空/非法时返回 undefined, 交给 proxy 内置默认值兜底 */
function parseOptionalPositiveNumber(value) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 非负数值解析: 允许 0(0=关闭对应能力), 空/非法时返回 undefined 交给 proxy 内置默认值兜底 */
function parseOptionalNonNegativeNumber(value) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// CLI 参数解析(目前只关心 --log-level / --help; 其余参数容忍, debug 记录)
const cli = parseCliArgs(process.argv.slice(2));
if (cli.help) {
    console.log(usageText());
    process.exit(0);
}
cli.errors.forEach((message) => logger.warn(`[CLI] ${message}`));
if (cli.unknown.length) {
    logger.debug('[CLI] Ignored unknown arguments', { args: cli.unknown });
}

// Default configuration
// LOG_LEVEL 不在此声明默认值: 优先级由 src/cli.js 统一解析(CLI > env > config.json > 旧 DEBUG > info)
const defaultConfig = {
    PORT: 8083,
    API_KEY: '',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:4097',
    OPENCODE_BIND_HOST: '127.0.0.1',
    OPENCODE_PATH: 'opencode',
    BIND_HOST: '127.0.0.1',
    DISABLE_TOOLS: false
};

// Load config from file
const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(content);
        logger.info('[Config] Loaded from config.json');
    } catch (err) {
        logger.error('[Config] Error parsing config.json:', { error: err.message });
    }
}

// 日志等级: CLI --log-level > env LOG_LEVEL > config.json LOG_LEVEL > 旧 DEBUG 开关 > 默认 info
// 任一层非法值都会告警并继续尝试下一优先级, 全部无效则回退 info
const legacyDebug = parseBool(
    process.env.OPENCODE_PROXY_DEBUG,
    parseBool(fileConfig.DEBUG, false)
);
const levelSettings = resolveLogLevelSettings({
    cliLevel: cli.logLevel,
    envLevel: process.env.LOG_LEVEL,
    fileLevel: fileConfig.LOG_LEVEL,
    legacyDebug
});
levelSettings.warnings.forEach((message) => logger.warn(`[Config] ${message}`));
logger.setLevel(levelSettings.level);

// 新增配置项的运行时优先级: env > config.json > 默认值(与既有键的合并方式一致)
const finalConfig = {
    PORT: parseInt(process.env.PORT) || fileConfig.PORT || defaultConfig.PORT,
    API_KEY: process.env.API_KEY || fileConfig.API_KEY || defaultConfig.API_KEY,
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || defaultConfig.OPENCODE_SERVER_URL,
    OPENCODE_BIND_HOST: process.env.OPENCODE_BIND_HOST || fileConfig.OPENCODE_BIND_HOST || defaultConfig.OPENCODE_BIND_HOST,
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || defaultConfig.OPENCODE_PATH,
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || defaultConfig.BIND_HOST,
    DISABLE_TOOLS: parseBool(process.env.OPENCODE_DISABLE_TOOLS, parseBool(fileConfig.DISABLE_TOOLS, defaultConfig.DISABLE_TOOLS)),
    // 生效日志等级 + 来源(启动日志打印, proxy 内不再重新推断)
    LOG_LEVEL: levelSettings.level,
    LOG_LEVEL_SOURCE: levelSettings.source,
    // 复杂任务: opencode 工作目录(默认空 -> proxy 用 jail 空目录)
    OPENCODE_WORKDIR: process.env.OPENCODE_WORKDIR || fileConfig.OPENCODE_WORKDIR || '',
    // 自动批准权限(默认开; 可用 env/config 关闭)
    OPENCODE_AUTO_APPROVE: parseBool(process.env.OPENCODE_AUTO_APPROVE, parseBool(fileConfig.OPENCODE_AUTO_APPROVE, true)),
    // 可选: 工具进度以 SSE 注释行输出
    OPENCODE_STREAM_TOOLS: parseBool(process.env.OPENCODE_STREAM_TOOLS, parseBool(fileConfig.OPENCODE_STREAM_TOOLS, false)),
    // 可选: tail opencode 日志文件(新行 debug 级转发)
    OPENCODE_LOG_TAIL: parseBool(process.env.OPENCODE_LOG_TAIL, parseBool(fileConfig.OPENCODE_LOG_TAIL, false)),
    OPENCODE_LOG_FILE: process.env.OPENCODE_LOG_FILE || fileConfig.OPENCODE_LOG_FILE || '',
    // 可选: opencode serve --print-logs(把 opencode 日志并进容器日志)
    OPENCODE_PRINT_LOGS: parseBool(process.env.OPENCODE_PRINT_LOGS, parseBool(fileConfig.OPENCODE_PRINT_LOGS, false)),
    // 系统提示词提升规则: JSON 数组 / 分号分隔正则; 未配置(含空字符串)用内置默认标记
    SYSTEM_PROMPT_PATTERNS: resolvePatternsSetting(process.env.SYSTEM_PROMPT_PATTERNS, fileConfig.SYSTEM_PROMPT_PATTERNS),
    // 超时/心跳: 未配置时由 proxy 内置默认值兜底(1800000 / 60000 / 15000)
    REQUEST_TIMEOUT_MS: parseOptionalPositiveNumber(process.env.REQUEST_TIMEOUT_MS ?? fileConfig.REQUEST_TIMEOUT_MS),
    EVENT_IDLE_TIMEOUT_MS: parseOptionalPositiveNumber(process.env.OPENCODE_EVENT_IDLE_TIMEOUT_MS ?? fileConfig.EVENT_IDLE_TIMEOUT_MS),
    SSE_HEARTBEAT_MS: parseOptionalPositiveNumber(process.env.OPENCODE_SSE_HEARTBEAT_MS ?? fileConfig.SSE_HEARTBEAT_MS),
    // 上游限流快速失败阈值(0=关闭阈值判断) / 排队上限(0=不限制) / 进度日志间隔 / 卡住阈值(0=关闭)
    FAST_FAIL_RETRY_MS: parseOptionalNonNegativeNumber(process.env.FAST_FAIL_RETRY_MS ?? fileConfig.FAST_FAIL_RETRY_MS),
    QUEUE_MAX_WAIT_MS: parseOptionalNonNegativeNumber(process.env.QUEUE_MAX_WAIT_MS ?? fileConfig.QUEUE_MAX_WAIT_MS),
    PROGRESS_LOG_INTERVAL_MS: parseOptionalNonNegativeNumber(process.env.PROGRESS_LOG_INTERVAL_MS ?? fileConfig.PROGRESS_LOG_INTERVAL_MS),
    STALL_WARN_MS: parseOptionalNonNegativeNumber(process.env.STALL_WARN_MS ?? fileConfig.STALL_WARN_MS)
};

// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
    logger.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
    process.exit(1);
}

// Check if opencode is available
import { execSync } from 'child_process';
try {
    execSync(`"${finalConfig.OPENCODE_PATH}" --version`, { stdio: 'ignore' });
} catch (e) {
    logger.warn(`[Warning] Cannot verify OpenCode installation: ${finalConfig.OPENCODE_PATH}`);
    logger.warn('[Warning] Please ensure OpenCode is installed:');
    logger.warn('  Windows: npm install -g opencode-ai');
    logger.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash');
    logger.warn('[Warning] Or specify the full path in config.json:');
    logger.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
}

logger.info('[Config] Starting with configuration:');
logger.info(`  - Port: ${finalConfig.PORT}`);
logger.info(`  - Bind Host: ${finalConfig.BIND_HOST}`);
logger.info(`  - Backend: ${finalConfig.OPENCODE_SERVER_URL}`);
logger.info(`  - Bind Host for OpenCode backend: ${finalConfig.OPENCODE_BIND_HOST}`);
logger.info(`  - OpenCode Path: ${finalConfig.OPENCODE_PATH}`);
logger.info(`  - API Key: ${finalConfig.API_KEY ? 'Configured' : 'Not configured (no auth)'}`);
logger.info(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
logger.info(`  - Log Level (effective): ${finalConfig.LOG_LEVEL} (source: ${finalConfig.LOG_LEVEL_SOURCE})`);
logger.info(`  - OpenCode Workdir: ${finalConfig.OPENCODE_WORKDIR || '(jail empty workspace)'}`);
logger.info(`  - Auto Approve Permissions: ${finalConfig.OPENCODE_AUTO_APPROVE ? 'Yes' : 'No'}`);
logger.info(`  - Stream Tool Progress (SSE comments): ${finalConfig.OPENCODE_STREAM_TOOLS ? 'Yes' : 'No'}`);
logger.info(`  - Tail OpenCode Log: ${finalConfig.OPENCODE_LOG_TAIL ? `Yes (${finalConfig.OPENCODE_LOG_FILE || 'auto-detect'})` : 'No'}`);
logger.info(`  - Print OpenCode Logs (--print-logs): ${finalConfig.OPENCODE_PRINT_LOGS ? 'Yes' : 'No'}`);
logger.info(`  - System Prompt Patterns: ${finalConfig.SYSTEM_PROMPT_PATTERNS ? `configured (${String(finalConfig.SYSTEM_PROMPT_PATTERNS).slice(0, 200)})` : 'default (built-in dsh markers)'}`);
if (finalConfig.REQUEST_TIMEOUT_MS) logger.info(`  - Request Timeout: ${finalConfig.REQUEST_TIMEOUT_MS}ms`);
logger.info(`  - Fast Fail Retry: ${finalConfig.FAST_FAIL_RETRY_MS === undefined ? 'default (60000ms)' : `${finalConfig.FAST_FAIL_RETRY_MS}ms${finalConfig.FAST_FAIL_RETRY_MS === 0 ? ' (disabled)' : ''}`}`);
logger.info(`  - Queue Max Wait: ${finalConfig.QUEUE_MAX_WAIT_MS === undefined ? 'default (60000ms)' : (finalConfig.QUEUE_MAX_WAIT_MS === 0 ? 'unlimited' : `${finalConfig.QUEUE_MAX_WAIT_MS}ms`)}`);
logger.info(`  - Progress Log Interval: ${finalConfig.PROGRESS_LOG_INTERVAL_MS === undefined ? 'default (300000ms)' : (finalConfig.PROGRESS_LOG_INTERVAL_MS === 0 ? 'disabled' : `${finalConfig.PROGRESS_LOG_INTERVAL_MS}ms`)}`);
logger.info(`  - Stall Warn: ${finalConfig.STALL_WARN_MS === undefined ? 'default (300000ms)' : (finalConfig.STALL_WARN_MS === 0 ? 'disabled' : `${finalConfig.STALL_WARN_MS}ms`)}`);
if (levelSettings.warnings.length) {
    logger.warn(`[Config] Log level warnings: ${levelSettings.warnings.join(' | ')}`);
}

// Start the proxy
try {
    const proxy = startProxy(finalConfig);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        logger.info('[Shutdown] Received SIGINT, shutting down gracefully...');
        proxy.stopLogTail();
        proxy.killBackend();
        proxy.server.close(() => {
            logger.info('[Shutdown] Server closed');
            process.exit(0);
        });
    });

    process.on('SIGTERM', () => {
        logger.info('[Shutdown] Received SIGTERM, shutting down gracefully...');
        proxy.stopLogTail();
        proxy.killBackend();
        proxy.server.close(() => {
            logger.info('[Shutdown] Server closed');
            process.exit(0);
        });
    });
} catch (error) {
    logger.error('[Fatal] Failed to start proxy:', { error: error.message, stack: error.stack });
    process.exit(1);
}
