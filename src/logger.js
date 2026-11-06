/**
 * 零依赖轻量日志模块(opencode-to-openai 网关)
 *
 * - 日志等级: error < warn < info < debug, 由 LOG_LEVEL 环境变量控制(不区分大小写)
 *   非法值回退 info 并告警; 未设置时默认 info
 * - 所有输出走 stdout/stderr(docker logs 可见), 统一带 [gateway] 前缀
 *   error/warn -> stderr, info/debug -> stdout
 * - 敏感信息脱敏: authorization / x-api-key / cookie 等敏感头输出前必须经 maskHeaders/maskSecret
 * - 输出格式: [gateway] <ISO时间> [LEVEL] 消息 {"detail":"json"}
 */

const PREFIX = '[gateway]';
const DEFAULT_LEVEL = 'info';

// 等级数值: 数值越大越详细; 输出判断用 "当前等级数值 >= 目标等级数值"(两边均为 number, 非字符串比较)
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// detail JSON 序列化的单值长度上限(debug 完整请求体/响应体可能很大, 超限截断并标注)
const MAX_SERIALIZED_LENGTH = 32 * 1024;
// 递归展开的最大深度与数组/对象成员上限, 防御超深嵌套导致日志爆炸
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 200;

/**
 * 解析日志等级字符串
 * @param {string|undefined|null} raw 原始值(如来自 LOG_LEVEL 环境变量)
 * @returns {{level: string, valid: boolean, explicit: boolean, requested: string|null}}
 *          level=解析后的等级; valid=false 表示非法(已回退 info); explicit=false 表示未提供
 */
export function resolveLogLevel(raw) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        return { level: DEFAULT_LEVEL, valid: true, explicit: false, requested: null };
    }
    const requested = String(raw).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, requested)) {
        return { level: requested, valid: true, explicit: true, requested };
    }
    return { level: DEFAULT_LEVEL, valid: false, explicit: true, requested: String(raw) };
}

/** 截断超长字符串并标注被截断的字符数 */
function truncateText(text, maxLen) {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…[truncated ${text.length - maxLen} chars]`;
}

/**
 * 安全克隆: 处理循环引用/超深嵌套/Error/BigInt, 保证后续 JSON.stringify 不抛异常
 * (非 JSON 值转为可读占位符, 不静默丢弃)
 */
function safeClone(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value !== 'object') return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: truncateText(String(value.stack || ''), 1000)
        };
    }
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[MaxDepthExceeded]';
    seen.add(value);
    let out;
    if (Array.isArray(value)) {
        out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeClone(item, seen, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) out.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    } else {
        out = {};
        const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
        keys.forEach((key) => {
            out[key] = safeClone(value[key], seen, depth + 1);
        });
        const hiddenKeys = Object.keys(value).length - keys.length;
        if (hiddenKeys > 0) out['[hiddenKeys]'] = hiddenKeys;
    }
    seen.delete(value);
    return out;
}

/**
 * 序列化任意值为单行 JSON 文本; 失败时输出占位符并注明原因(不裸吞)
 * @param {*} value 任意值
 * @returns {string}
 */
export function serializeDetail(value) {
    if (value === undefined) return '';
    let text;
    try {
        text = JSON.stringify(safeClone(value));
    } catch (e) {
        // JSON.stringify 理论上不会抛(safeClone 已消除循环引用), 兜底注明序列化失败原因
        return `[Unserializable detail: ${e && e.message ? e.message : 'unknown error'}]`;
    }
    if (text === undefined) return '[Unserializable detail: undefined]';
    return truncateText(text, MAX_SERIALIZED_LENGTH);
}

/** 敏感字符串脱敏: 保留首尾少量字符, 中间打码 */
export function maskSecret(text) {
    const str = String(text);
    if (str.length <= 8) return '***';
    return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

// 输出前必须脱敏的请求头名称(小写)
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'openai-organization',
    'cookie',
    'set-cookie'
]);

/**
 * 复制请求头对象并对敏感头(authorization/api-key/cookie 等)脱敏
 * @param {object} headers 原始请求头
 * @returns {object} 脱敏后的副本(不影响原对象)
 */
export function maskHeaders(headers) {
    const masked = {};
    Object.keys(headers || {}).forEach((name) => {
        const lower = String(name).toLowerCase();
        const value = headers[name];
        masked[name] = SENSITIVE_HEADER_NAMES.has(lower) ? maskSecret(value) : value;
    });
    return masked;
}

/**
 * 创建日志器实例
 * @param {{level?: string, prefix?: string}} options
 */
export function createLogger(options = {}) {
    const prefix = options.prefix || PREFIX;
    const state = { level: resolveLogLevel(options.level).level };

    function write(stream, levelName, message, detail) {
        let line = `${prefix} ${new Date().toISOString()} [${levelName.toUpperCase()}] ${message}`;
        if (detail !== undefined) {
            const serialized = serializeDetail(detail);
            if (serialized !== '') line += ` ${serialized}`;
        }
        stream.write(`${line}\n`);
    }

    return {
        /** 当前生效等级(只读) */
        get level() {
            return state.level;
        },
        /**
         * 更新等级
         * @param {string} raw 新等级原始值
         * @returns {{level: string, valid: boolean, explicit: boolean, requested: string|null}} 解析结果
         */
        setLevel(raw) {
            const result = resolveLogLevel(raw);
            state.level = result.level;
            return result;
        },
        /**
         * 是否启用某等级(数值比较, 两边均由 LEVELS 表转为 number)
         * @param {string} levelName 目标等级
         */
        isEnabled(levelName) {
            const current = LEVELS[state.level];
            const target = LEVELS[levelName];
            return current >= target;
        },
        /** error 级: 上游失败/启动致命问题, 恒输出, 走 stderr */
        error(message, detail) {
            if (LEVELS[state.level] >= LEVELS.error) write(process.stderr, 'error', message, detail);
        },
        /** warn 级: 非法配置回退/可自动恢复的异常, 走 stderr */
        warn(message, detail) {
            if (LEVELS[state.level] >= LEVELS.warn) write(process.stderr, 'warn', message, detail);
        },
        /** info 级: 启动信息/每请求摘要, 默认等级即可见, 走 stdout */
        info(message, detail) {
            if (LEVELS[state.level] >= LEVELS.info) write(process.stdout, 'info', message, detail);
        },
        /** debug 级: 完整请求体/响应/流程细节, 仅 LOG_LEVEL=debug 可见, 走 stdout */
        debug(message, detail) {
            if (LEVELS[state.level] >= LEVELS.debug) write(process.stdout, 'debug', message, detail);
        }
    };
}

// 进程级默认实例: 按环境变量 LOG_LEVEL 初始化(startProxy 内还会按 options 再次校准并告警)
export const logger = createLogger({ level: process.env.LOG_LEVEL });
