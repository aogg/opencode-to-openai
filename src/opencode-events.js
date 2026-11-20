/**
 * OpenCode 事件流处理(opencode-to-openai 网关)
 *
 * 职责:
 * - 订阅 opencode serve 的 SSE 事件流, 差量化 text/reasoning 增量(兼容 opencode>=1.19 无 delta 字段)
 * - 把 ToolPart 事件转成可读日志(info 级: 工具开始/完成/失败, 输入/结果摘要), 不污染模型正文
 * - permission.updated: 自动回复 once(OPENCODE_AUTO_APPROVE, 兜底+审计), 避免 permission ask 挂起
 * - session.status retry: 输出限流/重试信息(带 retry-after 摘要)
 * - 首个增量 / 空闲超时 / 工具活动重置 idle 计时
 *
 * 备注: opencode 1.19.5 的 `opencode serve` 不支持 `--auto`(传了会打印 help 并 exit 1),
 * 自动批准由"配置层 permission=allow + 本文件的 permission.updated 自动回复"两层实现。
 */

import { logger as defaultLogger } from './logger.js';

/** 单行预览(压掉换行 + 截断) */
export function previewText(value, maxLen = 120) {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…(+${text.length - maxLen} chars)`;
}

/**
 * 工具输入摘要: 常见字段优先(command/filePath/path/pattern...), 其余序列化
 * @param {object} input ToolPart.state.input
 * @param {number} maxLen
 */
export function summarizeToolInput(input, maxLen = 160) {
    if (!input || typeof input !== 'object') return '';
    const preferredKeys = ['command', 'filePath', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'content', 'todos'];
    for (const key of preferredKeys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim()) return previewText(value, maxLen);
        if (Array.isArray(value) && value.length) {
            return previewText(JSON.stringify(value), maxLen);
        }
    }
    try {
        return previewText(JSON.stringify(input), maxLen);
    } catch (e) {
        // 序列化失败不静默: 在日志里标注原因(不吞异常)
        return `[unserializable tool input: ${e.message}]`;
    }
}

/** 工具结果/错误摘要 */
export function summarizeToolState(state, maxLen = 200) {
    if (!state || typeof state !== 'object') return { status: 'unknown' };
    const summary = {
        status: state.status || 'unknown',
        input: summarizeToolInput(state.input)
    };
    if (typeof state.title === 'string' && state.title.trim()) summary.title = previewText(state.title, 120);
    if (typeof state.output === 'string') summary.output = previewText(state.output, maxLen);
    if (typeof state.error === 'string') summary.error = previewText(state.error, maxLen);
    if (state.time && typeof state.time.start === 'number') {
        summary.ms = typeof state.time.end === 'number' ? state.time.end - state.time.start : null;
    }
    return summary;
}

/** 从 retry 消息里提取 429/限流与重试提示 */
export function summarizeRetryMessage(message) {
    const text = String(message || '');
    const retryHint = text.match(/retry[- ]?after[^0-9]{0,8}(\d+(?:\.\d+)?)\s*(ms|s|seconds|秒)?/i);
    const waitHint = text.match(/(\d+(?:\.\d+)?)\s*(ms|s|seconds|秒)/i);
    return {
        rateLimited: /429|rate.?limit|overloaded|too many requests/i.test(text),
        retryAfter: retryHint ? retryHint[0] : (waitHint ? waitHint[0] : null),
        message: previewText(text, 300)
    };
}

/**
 * 订阅并收集一次 prompt 的事件
 *
 * @param {object} options
 * @param {object} options.client opencode SDK client
 * @param {string} options.sessionId 会话 id
 * @param {string|null} options.reqId 网关请求 id(日志串联)
 * @param {number} options.timeoutMs 总超时
 * @param {number} [options.firstDeltaTimeoutMs] 首包超时(0=不启用; 仅流式需要)
 * @param {number} [options.idleTimeoutMs] 空闲超时(工具活动会重置; 0=不启用)
 * @param {boolean} [options.autoApprovePermission] 是否自动批准权限请求
 * @param {string|null} [options.directory] opencode 工作目录(query.directory)
 * @param {Function|null} [options.onDelta] 文本增量回调 (delta, isReasoning)
 * @param {Function|null} [options.onTool] 工具/步骤活动回调, 用于可选 SSE 进度输出
 * @param {object} [options.logger] 日志器
 * @returns {{ready: Promise<boolean>, promise: Promise<object>, abort: Function, state: object}}
 */
export function collectSessionEvents(options) {
    const {
        client,
        sessionId,
        reqId = null,
        timeoutMs,
        firstDeltaTimeoutMs = 0,
        idleTimeoutMs = 0,
        autoApprovePermission = true,
        directory = null,
        onDelta = null,
        onTool = null,
        logger = defaultLogger
    } = options;

    const controller = new AbortController();
    const startedAt = Date.now();
    const state = {
        content: '',
        reasoning: '',
        receivedDelta: false,
        deltaChars: 0,
        firstDeltaAt: null,
        events: 0,
        toolCalls: new Map(),
        permissions: 0,
        autoApproved: 0,
        assistantError: null
    };

    let settled = false;
    let resolvePromise = null;
    const promise = new Promise((resolve) => {
        resolvePromise = resolve;
    });

    let timeoutId = null;
    let firstDeltaTimer = null;
    let idleTimer = null;

    function clearTimers() {
        if (timeoutId) clearTimeout(timeoutId);
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
        if (idleTimer) clearTimeout(idleTimer);
        timeoutId = null;
        firstDeltaTimer = null;
        idleTimer = null;
    }

    function finish(extra, reason) {
        if (settled) return;
        settled = true;
        clearTimers();
        try {
            controller.abort();
        } catch (e) {
            logger.debug('[opencode] abort event stream failed', { reqId, sessionId, error: e.message });
        }
        logger.debug('[opencode] event stream summary', {
            reqId,
            sessionId,
            reason,
            ms: Date.now() - startedAt,
            events: state.events,
            deltaChars: state.deltaChars,
            toolCalls: state.toolCalls.size,
            permissions: state.permissions,
            autoApproved: state.autoApproved
        });
        resolvePromise({
            content: state.content,
            reasoning: state.reasoning,
            receivedDelta: state.receivedDelta,
            deltaChars: state.deltaChars,
            firstDeltaAt: state.firstDeltaAt,
            events: state.events,
            toolCalls: [...state.toolCalls.values()],
            permissions: state.permissions,
            autoApproved: state.autoApproved,
            ms: Date.now() - startedAt,
            reason,
            error: null,
            ...extra
        });
    }

    function resetIdleTimer() {
        if (!idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            logger.debug('[opencode] event idle timeout', {
                reqId,
                sessionId,
                idleMs: idleTimeoutMs,
                deltaChars: state.deltaChars,
                toolCalls: state.toolCalls.size
            });
            finish({ idleTimeout: true }, 'idle-timeout');
        }, idleTimeoutMs);
    }

    timeoutId = setTimeout(() => {
        logger.warn('[Proxy] Request timeout while waiting for opencode events', {
            reqId,
            sessionId,
            timeoutMs,
            deltaChars: state.deltaChars,
            toolCalls: state.toolCalls.size
        });
        finish({ timedOut: true, error: new Error(`Request timeout after ${timeoutMs}ms`) }, 'timeout');
    }, timeoutMs);

    if (firstDeltaTimeoutMs) {
        firstDeltaTimer = setTimeout(() => {
            if (settled || state.receivedDelta) return;
            logger.debug('[opencode] no event data received before first-delta timeout', {
                reqId,
                sessionId,
                firstDeltaTimeoutMs
            });
            finish({ noData: true }, 'first-delta-timeout');
        }, firstDeltaTimeoutMs);
    }

    function handleToolPart(part) {
        const status = part.state?.status || 'unknown';
        const callId = part.callID || part.id;
        const previous = state.toolCalls.get(callId);
        // 同一工具 part 的状态可能被多次推送(metadata 变化), 只在状态变化时输出, 避免刷屏
        const changed = !previous || previous.status !== status;
        state.toolCalls.set(callId, {
            callId,
            tool: part.tool,
            status,
            partId: part.id,
            input: summarizeToolInput(part.state?.input)
        });

        // 工具活动一律重置 idle 计时: 复杂任务的工具阶段可能长时间无文本增量
        resetIdleTimer();

        if (!changed) return;
        const summary = summarizeToolState(part.state);
        const base = { reqId, sessionId, tool: part.tool, status, ...summary };

        if (status === 'running') {
            logger.info(`[opencode] tool running: ${part.tool}`, base);
        } else if (status === 'completed') {
            logger.info(`[opencode] tool completed: ${part.tool}`, base);
        } else if (status === 'error') {
            logger.warn(`[opencode] tool failed: ${part.tool}`, base);
        } else {
            logger.debug(`[opencode] tool ${status}: ${part.tool}`, base);
        }

        if (onTool) {
            try {
                onTool({ tool: part.tool, status, input: summary.input, output: summary.output || null, error: summary.error || null });
            } catch (e) {
                // 回调异常不静默: 记录后继续, 不能因客户端写失败中断事件收集
                logger.warn('[opencode] onTool callback failed', { reqId, sessionId, tool: part.tool, error: e.message });
            }
        }
    }

    function handleTextPart(part, properties) {
        /* opencode>=1.19 事件无 delta 字段, part.text 是该 part 当前全量文本, 按已累积内容差量化出增量 */
        let delta = properties?.delta;
        if (!delta && typeof part.text === 'string') {
            const accumulated = part.type === 'reasoning' ? state.reasoning : state.content;
            delta = part.text.startsWith(accumulated) ? part.text.slice(accumulated.length) : part.text;
        }
        if (!delta) return;

        state.receivedDelta = true;
        if (firstDeltaTimer) {
            clearTimeout(firstDeltaTimer);
            firstDeltaTimer = null;
        }
        resetIdleTimer();

        if (!state.firstDeltaAt) {
            state.firstDeltaAt = Date.now();
            logger.info('[Proxy] First delta received', {
                reqId,
                sessionId,
                ms: state.firstDeltaAt - startedAt,
                type: part.type
            });
        }

        if (part.type === 'reasoning') {
            state.reasoning += delta;
            if (onDelta) onDelta(delta, true);
        } else {
            state.content += delta;
            if (onDelta) onDelta(delta, false);
        }
        state.deltaChars += delta.length;
    }

    function handleMessageUpdated(event) {
        const info = event.properties?.info;
        if (!info || info.sessionID !== sessionId) return;
        if (info.error) {
            state.assistantError = info.error;
            logger.error('[opencode] assistant error event', {
                reqId,
                sessionId,
                errorName: info.error.name || null,
                errorMessage: previewText(info.error.data?.message || info.error.message, 300)
            });
        }
        if (info.finish === 'stop') {
            finish({ error: state.assistantError }, 'message-finished');
            return;
        }
        if (info.finish) {
            logger.debug('[opencode] message step finished', { reqId, sessionId, finish: info.finish });
        }
    }

    async function handlePermissionUpdated(event) {
        const permission = event.properties;
        if (!permission || permission.sessionID !== sessionId) return;
        state.permissions += 1;
        logger.info('[opencode] permission requested', {
            reqId,
            sessionId,
            permissionId: permission.id,
            type: permission.type,
            title: previewText(permission.title, 120),
            pattern: Array.isArray(permission.pattern)
                ? permission.pattern.map((p) => previewText(p, 80)).join(' | ')
                : (permission.pattern ? previewText(permission.pattern, 160) : null)
        });

        if (!autoApprovePermission) {
            logger.warn('[opencode] permission awaiting manual approval (OPENCODE_AUTO_APPROVE=false)', {
                reqId,
                sessionId,
                permissionId: permission.id,
                type: permission.type
            });
            return;
        }

        const params = {
            path: { id: sessionId, permissionID: permission.id },
            body: { response: 'once' }
        };
        if (directory) params.query = { directory };

        try {
            const result = await client.postSessionIdPermissionsPermissionId(params);
            if (result && result.error) {
                throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error).slice(0, 300));
            }
            state.autoApproved += 1;
            logger.info('[opencode] permission auto-approved', {
                reqId,
                sessionId,
                permissionId: permission.id,
                type: permission.type,
                response: 'once'
            });
        } catch (e) {
            // 自动批准失败必须告警: 请求会一直等到 REQUEST_TIMEOUT_MS
            logger.error('[opencode] permission auto-approve failed, request may hang until timeout', {
                reqId,
                sessionId,
                permissionId: permission.id,
                type: permission.type,
                error: e.message
            });
        }
    }

    function handleSessionStatus(event) {
        const properties = event.properties;
        if (!properties || properties.sessionID !== sessionId) return;
        const status = properties.status || {};
        if (status.type === 'retry') {
            const retry = summarizeRetryMessage(status.message);
            logger.warn('[opencode] session retry (upstream throttling/overload)', {
                reqId,
                sessionId,
                attempt: status.attempt,
                rateLimited: retry.rateLimited,
                retryAfter: retry.retryAfter,
                nextInMs: typeof status.next === 'number' ? status.next - Date.now() : null,
                message: retry.message
            });
            return;
        }
        logger.debug('[opencode] session status', { reqId, sessionId, status: status.type });
    }

    async function consume(stream) {
        for await (const event of stream) {
            if (settled) break;
            state.events += 1;
            const type = event?.type;
            if (type === 'message.part.updated') {
                const part = event.properties?.part;
                if (!part) continue;
                const partSession = part.sessionID || event.properties?.sessionID;
                if (partSession !== sessionId) continue;
                if (part.type === 'tool') {
                    handleToolPart(part);
                    continue;
                }
                if (part.type === 'step-start' || part.type === 'step-finish') {
                    logger.debug(`[opencode] ${part.type}`, { reqId, sessionId });
                    resetIdleTimer();
                    if (onTool) {
                        try {
                            onTool({ tool: null, status: part.type, input: null, output: null, error: null });
                        } catch (e) {
                            logger.warn('[opencode] onTool callback failed', { reqId, sessionId, error: e.message });
                        }
                    }
                    continue;
                }
                if (part.type !== 'text' && part.type !== 'reasoning') continue;
                handleTextPart(part, event.properties);
                continue;
            }
            if (type === 'message.updated') {
                handleMessageUpdated(event);
                if (settled) break;
                continue;
            }
            if (type === 'permission.updated') {
                await handlePermissionUpdated(event);
                continue;
            }
            if (type === 'permission.replied') {
                const properties = event.properties || {};
                if (properties.sessionID === sessionId) {
                    logger.debug('[opencode] permission replied', {
                        reqId,
                        sessionId,
                        permissionId: properties.permissionID,
                        response: properties.response
                    });
                }
                continue;
            }
            if (type === 'session.status') {
                handleSessionStatus(event);
                continue;
            }
            if (type === 'session.idle') {
                logger.debug('[opencode] session idle event', { reqId, sessionId });
                continue;
            }
            logger.debug('[opencode] event', { reqId, sessionId, type });
        }
        if (!settled) finish({}, 'stream-ended');
    }

    const ready = (async () => {
        try {
            const subscription = await client.event.subscribe({ signal: controller.signal });
            consume(subscription.stream).catch((e) => {
                if (settled) return;
                logger.error('[opencode] event stream consumer failed', { reqId, sessionId, error: e.message });
                finish({ error: e, streamError: true }, 'stream-error');
            });
            return true;
        } catch (e) {
            logger.error('[opencode] failed to subscribe event stream', { reqId, sessionId, error: e.message });
            finish({ error: e, streamError: true }, 'subscribe-error');
            return false;
        }
    })();

    return {
        ready,
        promise,
        state,
        abort: () => finish({ aborted: true }, 'aborted')
    };
}
