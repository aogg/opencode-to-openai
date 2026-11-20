/**
 * 在途请求注册表(进度日志 + 卡住看门狗 + 在途查询)
 *
 * 解决两个线上可观测性问题:
 * 1) 请求跑很久时日志只有开头和结尾, 中间没有任何"还在执行"的证据 ——
 *    每个在途请求每 PROGRESS_LOG_INTERVAL_MS(默认 5 分钟)输出一条 INFO 进度;
 * 2) 想查"5 分钟内没有反应的有哪些"只能翻日志翻不出来 ——
 *    内存里维护 reqId -> 状态 的注册表, 看门狗每 30s 扫描一次,
 *    idleMs > STALL_WARN_MS(默认 5 分钟)打 WARN, 并提供 GET /v1/gateway/inflight 查询。
 *
 * 所有定时器随请求结束/注册表关闭清理, 不会泄漏(unref 后也不阻止进程退出)。
 */

import { logger as defaultLogger } from './logger.js';

/** 默认进度日志间隔(毫秒): 5 分钟 */
export const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 300000;
/** 默认"卡住"判定阈值(毫秒): 5 分钟没有活动 */
export const DEFAULT_STALL_WARN_MS = 300000;
/** 默认看门狗扫描间隔(毫秒) */
export const DEFAULT_STALL_CHECK_INTERVAL_MS = 30000;

/**
 * 创建在途请求注册表
 *
 * @param {object} [options]
 * @param {object} [options.logger] 日志器
 * @param {number} [options.progressIntervalMs] 进度日志间隔, 0=关闭
 * @param {number} [options.stallWarnMs] 卡住阈值, 0=关闭告警
 * @param {number} [options.stallCheckIntervalMs] 看门狗扫描间隔, 0=不自动起定时器
 * @param {Function} [options.now] 时间源(测试可注入)
 */
export function createInflightRegistry(options = {}) {
    const logger = options.logger || defaultLogger;
    const toNonNegative = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const progressIntervalMs = toNonNegative(options.progressIntervalMs, DEFAULT_PROGRESS_LOG_INTERVAL_MS);
    const stallWarnMs = toNonNegative(options.stallWarnMs, DEFAULT_STALL_WARN_MS);
    const stallCheckIntervalMs = toNonNegative(options.stallCheckIntervalMs, DEFAULT_STALL_CHECK_INTERVAL_MS);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    const entries = new Map();
    let watchdogTimer = null;

    /** 进度日志/看门狗/查询共用的字段(全部基于注册表里的最新状态) */
    function progressFields(entry, current = now()) {
        return {
            reqId: entry.reqId,
            phase: entry.phase,
            model: entry.model,
            stream: entry.stream,
            sessionId: entry.sessionId,
            startedAt: entry.startedAt,
            elapsedMs: Math.max(0, current - entry.startedAt),
            idleMs: Math.max(0, current - entry.lastActivityAt),
            queueWaitMs: entry.queueWaitMs,
            deltaChars: entry.deltaChars,
            lastEvent: entry.lastEvent
        };
    }

    /** 对外的请求快照(字段与 GET /v1/gateway/inflight 响应一致) */
    function requestSnapshot(entry, current = now()) {
        const fields = progressFields(entry, current);
        return {
            reqId: fields.reqId,
            phase: fields.phase,
            model: fields.model,
            stream: fields.stream,
            sessionId: fields.sessionId,
            startedAt: fields.startedAt,
            elapsedMs: fields.elapsedMs,
            idleMs: fields.idleMs,
            queueWaitMs: fields.queueWaitMs,
            deltaChars: fields.deltaChars,
            lastEvent: fields.lastEvent,
            stalled: stallWarnMs > 0 && fields.idleMs > stallWarnMs
        };
    }

    /** 移除请求并清理它的进度定时器 */
    function remove(reqId) {
        if (!reqId) return false;
        const entry = entries.get(reqId);
        if (!entry) return false;
        if (entry.progressTimer) {
            clearInterval(entry.progressTimer);
            entry.progressTimer = null;
        }
        entries.delete(reqId);
        return true;
    }

    /**
     * 登记一个在途请求(重复 reqId 会先移除旧记录)
     * @param {{reqId: string, phase?: string, model?: string|null, stream?: boolean,
     *          sessionId?: string|null, queueWaitMs?: number, startedAt?: number}} meta
     */
    function register(meta = {}) {
        const reqId = meta.reqId;
        if (!reqId) {
            logger.warn('[Proxy] Inflight register ignored: reqId is required');
            return null;
        }
        remove(reqId);
        const startedAt = Number.isFinite(meta.startedAt) ? meta.startedAt : now();
        const entry = {
            reqId,
            phase: meta.phase || 'queue',
            model: meta.model || null,
            stream: Boolean(meta.stream),
            sessionId: meta.sessionId || null,
            startedAt,
            lastActivityAt: now(),
            lastEvent: null,
            deltaChars: 0,
            queueWaitMs: Number.isFinite(meta.queueWaitMs) ? meta.queueWaitMs : 0,
            lastStallWarnAt: 0,
            progressTimer: null
        };
        entries.set(reqId, entry);

        if (progressIntervalMs > 0) {
            entry.progressTimer = setInterval(() => logProgress(reqId), progressIntervalMs);
            if (typeof entry.progressTimer.unref === 'function') entry.progressTimer.unref();
        }
        logger.debug('[Proxy] Inflight request registered', { reqId, phase: entry.phase, total: entries.size });
        return entry;
    }

    /**
     * 更新请求状态(阶段切换/会话创建/模型解析等). 任何更新都视为一次活动。
     * 请求已结束时静默忽略(事件晚到是正常现象)。
     * @param {string} reqId
     * @param {{phase?: string, model?: string|null, stream?: boolean, sessionId?: string|null,
     *          deltaChars?: number, lastEvent?: string|null, queueWaitMs?: number}} patch
     */
    function update(reqId, patch = {}) {
        const entry = entries.get(reqId);
        if (!entry) return null;
        if (patch.phase) entry.phase = patch.phase;
        if (patch.model) entry.model = patch.model;
        if (typeof patch.stream === 'boolean') entry.stream = patch.stream;
        if (patch.sessionId) entry.sessionId = patch.sessionId;
        if (Number.isFinite(patch.deltaChars)) entry.deltaChars = patch.deltaChars;
        if (patch.lastEvent) entry.lastEvent = patch.lastEvent;
        if (Number.isFinite(patch.queueWaitMs)) entry.queueWaitMs = patch.queueWaitMs;
        entry.lastActivityAt = now();
        return entry;
    }

    /** 输出一条进度日志(定时器调用; 也供测试直接调用) */
    function logProgress(reqId) {
        const entry = entries.get(reqId);
        if (!entry) return null;
        const fields = progressFields(entry);
        logger.info('[Proxy] Request progress', fields);
        return fields;
    }

    /**
     * 扫描卡住请求: idleMs > stallWarnMs 打 WARN, 同一请求每个 stallWarnMs 窗口内最多报一次
     * @returns {object[]} 本次被标记的请求快照
     */
    function checkStalled() {
        if (!(stallWarnMs > 0)) return [];
        const current = now();
        const flagged = [];
        entries.forEach((entry) => {
            const idleMs = current - entry.lastActivityAt;
            if (idleMs <= stallWarnMs) return;
            if (entry.lastStallWarnAt && current - entry.lastStallWarnAt < stallWarnMs) return;
            entry.lastStallWarnAt = current;
            logger.warn('[Proxy] Stalled request', {
                reqId: entry.reqId,
                idleMs,
                phase: entry.phase,
                sessionId: entry.sessionId,
                model: entry.model,
                stream: entry.stream,
                deltaChars: entry.deltaChars
            });
            flagged.push(requestSnapshot(entry, current));
        });
        return flagged;
    }

    /** 启动看门狗定时器(幂等) */
    function startWatchdog() {
        if (watchdogTimer || !(stallCheckIntervalMs > 0)) return;
        watchdogTimer = setInterval(checkStalled, stallCheckIntervalMs);
        if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
    }

    /** 停止看门狗 */
    function stopWatchdog() {
        if (!watchdogTimer) return;
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }

    /** 在途请求快照(GET /v1/gateway/inflight 的响应体) */
    function snapshot() {
        const current = now();
        const requests = [];
        entries.forEach((entry) => requests.push(requestSnapshot(entry, current)));
        return {
            now: current,
            count: requests.length,
            stalled: requests.filter((item) => item.stalled).length,
            requests
        };
    }

    /** 关闭注册表: 清掉看门狗与全部进度定时器(进程退出/服务关闭时调用) */
    function stop() {
        stopWatchdog();
        [...entries.keys()].forEach((reqId) => remove(reqId));
    }

    return {
        register,
        update,
        remove,
        logProgress,
        checkStalled,
        startWatchdog,
        stopWatchdog,
        snapshot,
        stop,
        /** 当前在途数量(日志用) */
        get size() {
            return entries.size;
        }
    };
}
