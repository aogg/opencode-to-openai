/**
 * 单并发队列(带排队上限)
 *
 * 背景: 网关同一时刻只允许一个请求占用 opencode 后端(单并发锁)。旧实现只有"任务超时"(
 * REQUEST_TIMEOUT_MS + 20s), 上游卡住时后续请求会在队列里一直排下去(线上实测排了 298 秒),
 * 用户看到的是"发了没反应"。
 *
 * 现在增加排队上限 QUEUE_MAX_WAIT_MS(默认 60000):
 * - 排队超过上限的请求直接以 QueueTimeoutError 结束(proxy 转成 HTTP 503 gateway_queue_timeout),
 *   不再白等一个卡住的请求;
 * - 0 表示不限制排队时长(保留旧行为)。
 */

import { logger as defaultLogger } from './logger.js';

/** 默认排队上限(毫秒) */
export const DEFAULT_QUEUE_MAX_WAIT_MS = 60000;
/** 默认单个任务执行超时(毫秒), 与旧 lock() 默认值一致 */
export const DEFAULT_TASK_TIMEOUT_MS = 120000;
/** 默认任务完成后让出事件循环的间隔(毫秒), 与旧实现一致 */
const DEFAULT_NEXT_DELAY_MS = 100;

/** 排队超时错误(proxy 据此返回 503) */
export class QueueTimeoutError extends Error {
    /**
     * @param {number} waitedMs 实际排队时长(毫秒)
     * @param {number} maxWaitMs 排队上限(毫秒)
     */
    constructor(waitedMs, maxWaitMs) {
        super(`queue wait exceeded ${maxWaitMs}ms (waited ${waitedMs}ms)`);
        this.name = 'QueueTimeoutError';
        this.code = 'GATEWAY_QUEUE_TIMEOUT';
        this.waitedMs = waitedMs;
        this.maxWaitMs = maxWaitMs;
    }
}

/** 判断是否是排队超时错误 */
export function isQueueTimeoutError(error) {
    return Boolean(error && (error instanceof QueueTimeoutError || error.code === 'GATEWAY_QUEUE_TIMEOUT'));
}

/**
 * 排队超时的 HTTP 响应(proxy 直接使用; 抽成纯函数便于测试 503 契约)
 * @param {QueueTimeoutError|object} error
 * @returns {{status: number, body: {error: {message: string, type: string, waited_ms: number}}}}
 */
export function buildQueueTimeoutResponse(error) {
    const waitedMs = error && Number.isFinite(error.waitedMs) ? error.waitedMs : 0;
    return {
        status: 503,
        body: {
            error: {
                message: '网关排队超时，请稍后重试',
                type: 'gateway_queue_timeout',
                waited_ms: waitedMs
            }
        }
    };
}

/**
 * 创建单并发队列
 *
 * @param {object} [options]
 * @param {object} [options.logger] 日志器
 * @param {number} [options.maxWaitMs] 排队上限(0=不限制)
 * @param {number} [options.nextDelayMs] 任务完成后让出事件循环的间隔
 * @param {Function} [options.now] 时间源(测试可注入)
 */
export function createSerialQueue(options = {}) {
    const logger = options.logger || defaultLogger;
    const maxWaitMs = Number.isFinite(Number(options.maxWaitMs)) && Number(options.maxWaitMs) >= 0
        ? Number(options.maxWaitMs)
        : DEFAULT_QUEUE_MAX_WAIT_MS;
    const nextDelayMs = Number.isFinite(Number(options.nextDelayMs)) && Number(options.nextDelayMs) >= 0
        ? Number(options.nextDelayMs)
        : DEFAULT_NEXT_DELAY_MS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    const queue = [];
    let running = false;
    let disposed = false;

    function unrefTimer(timer) {
        if (timer && typeof timer.unref === 'function') timer.unref();
        return timer;
    }

    /** 任务真正结束后释放队列, 继续下一个 */
    function complete() {
        running = false;
        if (disposed) return;
        setTimeout(() => pump(), nextDelayMs);
    }

    function run(item) {
        running = true;
        if (item.waitTimer) {
            clearTimeout(item.waitTimer);
            item.waitTimer = null;
        }
        const timeoutMs = item.timeoutMs;
        item.timeoutTimer = unrefTimer(setTimeout(() => {
            if (item.settled) return;
            /* 与旧实现一致: 超时先 reject, 队列锁等 task 真正结束再释放(避免两个请求同时压上游) */
            item.settled = true;
            item.reject(new Error(`Request timeout after ${timeoutMs}ms`));
        }, timeoutMs));

        let taskPromise;
        try {
            taskPromise = Promise.resolve().then(() => item.task());
        } catch (e) {
            taskPromise = Promise.reject(e);
        }
        taskPromise
            .then((result) => {
                if (item.settled) return;
                item.settled = true;
                if (item.timeoutTimer) clearTimeout(item.timeoutTimer);
                item.resolve(result);
            }, (error) => {
                if (item.settled) return;
                item.settled = true;
                if (item.timeoutTimer) clearTimeout(item.timeoutTimer);
                item.reject(error);
            })
            .finally(() => {
                if (item.timeoutTimer) clearTimeout(item.timeoutTimer);
                complete();
            });
    }

    /** 取出下一个可执行任务 */
    function pump() {
        if (disposed || running) return;
        while (queue.length > 0) {
            const item = queue.shift();
            if (item.settled) continue;
            const waitedMs = now() - item.enqueuedAt;
            if (maxWaitMs > 0 && waitedMs > maxWaitMs) {
                item.settled = true;
                if (item.waitTimer) clearTimeout(item.waitTimer);
                item.reject(new QueueTimeoutError(waitedMs, maxWaitMs));
                continue;
            }
            run(item);
            return;
        }
    }

    /**
     * 入队一个任务
     * @param {Function} task 要执行的异步任务
     * @param {{timeoutMs?: number, reqId?: string|null}} [taskOptions]
     * @returns {Promise<any>}
     */
    function enqueue(task, taskOptions = {}) {
        return new Promise((resolve, reject) => {
            if (disposed) {
                reject(new Error('serial queue disposed'));
                return;
            }
            const item = {
                task,
                timeoutMs: Number.isFinite(Number(taskOptions.timeoutMs)) && Number(taskOptions.timeoutMs) > 0
                    ? Number(taskOptions.timeoutMs)
                    : DEFAULT_TASK_TIMEOUT_MS,
                reqId: taskOptions.reqId || null,
                enqueuedAt: now(),
                settled: false,
                resolve,
                reject,
                waitTimer: null,
                timeoutTimer: null
            };
            if (maxWaitMs > 0) {
                /* 排队计时从入队开始: 上游卡住时也能按上限及时返回 503, 不必等前一个任务结束 */
                item.waitTimer = unrefTimer(setTimeout(() => {
                    if (item.settled) return;
                    const index = queue.indexOf(item);
                    if (index === -1) {
                        /* 已经开始执行(等锁成功), 排队计时不再生效 */
                        return;
                    }
                    queue.splice(index, 1);
                    item.settled = true;
                    item.reject(new QueueTimeoutError(now() - item.enqueuedAt, maxWaitMs));
                    logger.debug('[Proxy] Queue item timed out while waiting', {
                        reqId: item.reqId,
                        waitedMs: now() - item.enqueuedAt,
                        maxWaitMs,
                        queueLength: queue.length
                    });
                    pump();
                }, maxWaitMs));
            }
            queue.push(item);
            pump();
        });
    }

    /** 关闭队列: 拒绝所有排队任务并停止调度 */
    function dispose() {
        disposed = true;
        while (queue.length > 0) {
            const item = queue.shift();
            if (item.settled) continue;
            item.settled = true;
            if (item.waitTimer) clearTimeout(item.waitTimer);
            item.reject(new Error('serial queue disposed'));
        }
    }

    return {
        enqueue,
        dispose,
        /** 当前排队长度(不含正在执行的) */
        get length() {
            return queue.length;
        },
        /** 是否有任务正在执行 */
        get isProcessing() {
            return running;
        },
        get maxWaitMs() {
            return maxWaitMs;
        }
    };
}
