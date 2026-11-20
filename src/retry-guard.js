/**
 * 上游限流/额度耗尽快速失败(不再干等 300 秒)
 *
 * 背景: 上游 opencode 遇到免费额度耗尽/限流时会发 session.status=retry 事件,
 * 例如 {"attempt":1,"rateLimited":false,"retryAfter":null,"nextInMs":51401998,
 *       "message":"Free usage exceeded, subscribe to Go"} —— 相当于要等 14 小时。
 * 旧逻辑只打一条 warn 然后继续等 REQUEST_TIMEOUT_MS(300s), 单并发队列还会把后续请求一起堵死。
 *
 * 这里把"该不该快速失败"抽成纯函数(便于单测):
 * - nextInMs 超过 FAST_FAIL_RETRY_MS(默认 60000, 0 表示关闭该阈值判断) -> 快速失败
 * - message 命中额度类文案(free usage / quota / subscribe / rate limit ...) -> 立即快速失败
 * - 其余情况(重试很快就到, 且不是额度问题) -> 继续等待
 */

/** 默认重试等待上限: 超过就快速失败(毫秒) */
export const DEFAULT_FAST_FAIL_RETRY_MS = 60000;

/** 额度类文案关键词(小写匹配; 命中任意一个立即快速失败) */
export const QUOTA_MESSAGE_KEYWORDS = [
    'free usage',
    'usage exceeded',
    'usage limit',
    'quota',
    'subscribe',
    'rate limit',
    'rate-limit',
    'rate limited',
    'too many requests',
    'insufficient'
];

/**
 * 归一化上游 retry 事件里的重试信息
 * @param {object} status session.status 事件的 status 对象
 * @returns {{attempt: number|null, nextInMs: number|null, retryAfter: any, message: string, rateLimited: boolean}}
 */
export function normalizeRetryStatus(status = {}) {
    const source = status && typeof status === 'object' ? status : {};
    const attempt = Number.isFinite(source.attempt) ? source.attempt : null;
    const message = typeof source.message === 'string' ? source.message : '';

    /* 兼容两种字段: 上游直接给相对毫秒 nextInMs, 或给绝对时间戳 next(旧逻辑按 next - now 计算) */
    let nextInMs = null;
    if (Number.isFinite(source.nextInMs)) {
        nextInMs = source.nextInMs;
    } else if (Number.isFinite(source.next)) {
        nextInMs = source.next - Date.now();
    }
    if (nextInMs !== null && nextInMs < 0) nextInMs = 0;

    return {
        attempt,
        nextInMs,
        retryAfter: source.retryAfter ?? null,
        message,
        rateLimited: Boolean(source.rateLimited)
    };
}

/**
 * 查找额度类文案关键词
 * @param {string} message
 * @returns {string|null}
 */
export function findQuotaKeyword(message) {
    const text = String(message || '').toLowerCase();
    if (!text) return null;
    for (const keyword of QUOTA_MESSAGE_KEYWORDS) {
        if (text.includes(keyword)) return keyword;
    }
    return null;
}

/**
 * 判断是否该快速失败
 * @param {{nextInMs?: number|null, message?: string, fastFailRetryMs?: number}} options
 * @returns {{shouldFail: boolean, reason: string|null, keyword: string|null,
 *            nextInMs: number|null, retryAfterMs: number}}
 */
export function decideFastFail(options = {}) {
    const nextInMs = Number.isFinite(options.nextInMs) ? options.nextInMs : null;
    const message = String(options.message || '');
    const limit = Number(options.fastFailRetryMs);
    const limitEnabled = Number.isFinite(limit) && limit > 0;

    const keyword = findQuotaKeyword(message);
    if (keyword) {
        return {
            shouldFail: true,
            reason: 'quota-message',
            keyword,
            nextInMs,
            retryAfterMs: nextInMs !== null ? Math.round(nextInMs) : 0
        };
    }
    if (limitEnabled && nextInMs !== null && nextInMs > limit) {
        return {
            shouldFail: true,
            reason: 'next-in-too-far',
            keyword: null,
            nextInMs,
            retryAfterMs: Math.round(nextInMs)
        };
    }
    return { shouldFail: false, reason: null, keyword: null, nextInMs, retryAfterMs: nextInMs !== null ? Math.round(nextInMs) : 0 };
}

/** 快速失败时抛出的错误(proxy 用它区分普通错误) */
export class UpstreamRetryError extends Error {
    /**
     * @param {object} info {nextInMs, retryAfterMs, message, reason, keyword, attempt, elapsedMs}
     */
    constructor(info = {}) {
        super(`upstream retry fast-fail: ${info.message || 'upstream throttled'}`);
        this.name = 'UpstreamRetryError';
        this.code = 'GATEWAY_UPSTREAM_RETRY';
        this.info = info;
    }
}

/** 判断是否是快速失败错误 */
export function isUpstreamRetryError(error) {
    return Boolean(error && (error instanceof UpstreamRetryError || error.code === 'GATEWAY_UPSTREAM_RETRY'));
}

/** 单行预览(压掉换行 + 截断), 避免把长文案带进响应/日志 */
function previewMessage(value, maxLen = 200) {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…(+${text.length - maxLen} chars)`;
}

/**
 * 构造快速失败的 HTTP 响应(非流式 429 / 流式 SSE error 事件共用同一份 error 体)
 * @param {object} info 快速失败信息
 * @returns {{status: number, body: {error: {message: string, type: string, retry_after_ms: number}}}}
 */
export function buildRetryFailure(info = {}) {
    const raw = previewMessage(info.message, 200);
    const retryAfterMs = Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0
        ? Math.round(info.retryAfterMs)
        : 0;
    const seconds = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0;
    const waitText = seconds > 0 ? `请 ${seconds} 秒后重试` : '请稍后重试';
    const message = raw
        ? `上游限流，${waitText}（${raw}）`
        : `上游限流，${waitText}`;
    return {
        status: 429,
        body: {
            error: {
                message,
                type: 'gateway_upstream_retry',
                retry_after_ms: retryAfterMs
            }
        }
    };
}

/**
 * 带超时 + 快速失败信号的等待。
 *
 * 与旧的 Promise.race(prompt, 300s 定时器) 的区别: 收到快速失败信号时立即 reject,
 * 不再被 300s 的超时定时器拖住; 正常完成/超时/快速失败都会清掉定时器(不泄漏)。
 *
 * @param {Promise<any>} promptPromise 上游 prompt 调用
 * @param {number} timeoutMs 总超时(毫秒)
 * @param {Promise<object>|null} fastFailPromise 快速失败信号(collector.fastFailPromise)
 * @returns {Promise<any>}
 */
export function waitForPrompt(promptPromise, timeoutMs, fastFailPromise = null) {
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    const racers = [promptPromise, timeoutPromise];
    if (fastFailPromise) {
        racers.push(fastFailPromise.then((info) => {
            throw new UpstreamRetryError(info);
        }));
    }
    return Promise.race(racers).finally(() => {
        /* 正常完成/快速失败/超时都要清定时器, 避免每个请求残留一个长定时器 */
        if (timeoutId) clearTimeout(timeoutId);
    });
}
