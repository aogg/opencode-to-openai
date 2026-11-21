/**
 * OpenCode 事件流处理(opencode-to-openai 网关)
 *
 * 职责:
 * - 订阅 opencode serve 的 SSE 事件流, 差量化 text/reasoning 增量(兼容 opencode>=1.19 无 delta 字段)
 * - 只把 **assistant 消息** 的 text/reasoning part 计入增量: opencode 对 user message 的 part 也发
 *   message.part.updated, 不过滤会把客户端的 "# 角色注入 / 系统提示词 / system-reminder"(role=user)
 *   原样回显成 assistant 首包
 * - 把 ToolPart 事件转成可读日志(info 级: 工具开始/完成/失败, 输入/结果摘要), 不污染模型正文
 * - permission.updated: 自动回复 once(OPENCODE_AUTO_APPROVE, 兜底+审计), 避免 permission ask 挂起
 * - session.status retry: 输出限流/重试信息; nextInMs 过大或命中额度类文案时立即快速失败
 *   (FAST_FAIL_RETRY_MS), 并通过 client.session.abort 尽力取消上游, 不再干等 300 秒
 * - 输出侧兜底: assistant 文本里若出现系统注入标记(上游把 user/system 内容当 assistant part 回显),
 *   按增量裁掉(只对行首做缓冲判定, 正常文本不增加延迟)
 * - 首个增量 / 空闲超时 / 工具活动重置 idle 计时
 * - onActivity 回调: 每个事件/增量都上报活动, 供在途注册表(进度日志/看门狗)使用
 *
 * 备注: opencode 1.19.5 的 `opencode serve` 不支持 `--auto`(传了会打印 help 并 exit 1),
 * 自动批准由"配置层 permission=allow + 本文件的 permission.updated 自动回复"两层实现。
 */

import { logger as defaultLogger } from './logger.js';
import { buildEchoPatterns, createStreamEchoFilter } from './output-guard.js';
import { decideFastFail, normalizeRetryStatus } from './retry-guard.js';

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
 * 从 assistant 消息的 parts 里汇总正文/推理(轮询兜底用)
 * 只统计该条消息(调用方已确认 role=assistant)的 text/reasoning part;
 * 输出侧仍会再过一遍 sanitizeAssistantText(见 src/proxy.js), 防止上游把 user/system 内容塞进 assistant part。
 * @param {Array} parts
 * @returns {{content: string, reasoning: string}}
 */
export function extractFromParts(parts) {
    if (!Array.isArray(parts)) return { content: '', reasoning: '' };
    const content = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
    const reasoning = parts.filter((p) => p && p.type === 'reasoning' && typeof p.text === 'string').map((p) => p.text).join('');
    return { content, reasoning };
}

/** 上游每一轮(step)的中间态 finish: 不代表本轮结束, 上游会新建 assistant 消息继续跑 */
export const NON_TERMINAL_ASSISTANT_FINISH = ['tool-calls', 'unknown'];

/**
 * assistant 消息的 finish 是否代表本轮结束
 * 与 opencode session/prompt.ts 的 loop 退出条件一致: finish 存在且不是 tool-calls/unknown。
 * @param {string|null|undefined} finish
 * @returns {boolean}
 */
export function isTerminalAssistantFinish(finish) {
    return typeof finish === 'string' && finish.length > 0 && !NON_TERMINAL_ASSISTANT_FINISH.includes(finish);
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
 * @param {Function|null} [options.onActivity] 任意事件/增量回调({type, events, deltaChars}), 供在途注册表使用
 * @param {number} [options.fastFailRetryMs] 上游 retry 的等待阈值(0=关闭阈值判断; 额度类文案总是快速失败)
 * @param {object[]|string[]|null} [options.echoPatterns] 输出侧系统注入标记(默认内置)
 * @param {object} [options.logger] 日志器
 * @returns {{ready: Promise<boolean>, promise: Promise<object>, fastFailPromise: Promise<object>,
 *            getFastFail: Function, abort: Function, state: object}}
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
        onActivity = null,
        fastFailRetryMs = 60000,
        echoPatterns = null,
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
        assistantError: null,
        echoRemovedChars: 0
    };

    /* 输出侧兜底标记: 与系统提示词提升共用同一套正则(另加角色前缀等额外标记) */
    const echoSources = echoPatterns && Array.isArray(echoPatterns) && echoPatterns.length
        ? echoPatterns
        : buildEchoPatterns(null);
    const contentEchoFilter = createStreamEchoFilter({
        patterns: echoSources,
        onHit: (hit) => logger.warn('[opencode] system prompt echo removed from assistant content', {
            reqId,
            sessionId,
            channel: 'content',
            marker: hit.marker,
            phase: hit.phase,
            removedChars: hit.removedChars
        })
    });
    const reasoningEchoFilter = createStreamEchoFilter({
        patterns: echoSources,
        onHit: (hit) => logger.warn('[opencode] system prompt echo removed from assistant reasoning', {
            reqId,
            sessionId,
            channel: 'reasoning',
            marker: hit.marker,
            phase: hit.phase,
            removedChars: hit.removedChars
        })
    });

    /* 快速失败信号: 收到上游明确限流/额度耗尽时 resolve, proxy 用它立即结束请求(不再等 300s) */
    let fastFailInfo = null;
    let resolveFastFail = null;
    const fastFailPromise = new Promise((resolve) => {
        resolveFastFail = resolve;
    });

    /* messageID -> role(message.updated 或 session.messages 回填): text/reasoning part 只认 assistant */
    const messageRoles = new Map();
    /* 每个未知 messageID 只触发一次 session.messages 查询, 失败不重试(流式有兜底轮询) */
    const roleLookups = new Set();
    let roleLookupCount = 0;
    let roleLookupFailed = 0;

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
        /* 先冲刷增量过滤器缓冲: 短回复可能在"行首判定"完成前就结束, 不冲刷会丢字 */
        flushEchoBuffers();
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
            echoRemovedChars: state.echoRemovedChars,
            toolCalls: state.toolCalls.size,
            permissions: state.permissions,
            autoApproved: state.autoApproved,
            roleLookups: roleLookupCount,
            roleLookupFailed
        });
        resolvePromise({
            content: state.content,
            reasoning: state.reasoning,
            receivedDelta: state.receivedDelta,
            deltaChars: state.deltaChars,
            echoRemovedChars: state.echoRemovedChars,
            firstDeltaAt: state.firstDeltaAt,
            events: state.events,
            toolCalls: [...state.toolCalls.values()],
            permissions: state.permissions,
            autoApproved: state.autoApproved,
            ms: Date.now() - startedAt,
            reason,
            error: null,
            fastFail: fastFailInfo,
            ...extra
        });
    }

    /** 把增量过滤器里缓冲的文本冲出来(结束/异常结束都要调用) */
    function flushEchoBuffers() {
        const contentRest = contentEchoFilter.flush();
        if (contentRest) applyDelta(contentRest, false);
        const reasoningRest = reasoningEchoFilter.flush();
        if (reasoningRest) applyDelta(reasoningRest, true);
        const contentStats = contentEchoFilter.stats();
        const reasoningStats = reasoningEchoFilter.stats();
        state.echoRemovedChars = contentStats.removedChars + reasoningStats.removedChars;
    }

    /** 计入增量并回调(统一入口: 增量过滤器/冲刷都走这里) */
    function applyDelta(delta, isReasoning) {
        if (!delta) return;
        if (isReasoning) {
            state.reasoning += delta;
        } else {
            state.content += delta;
        }
        state.deltaChars += delta.length;
        if (onDelta) {
            try {
                onDelta(delta, isReasoning);
            } catch (e) {
                // 回调异常不静默: 记录后继续, 不能因客户端写失败中断事件收集
                logger.warn('[opencode] onDelta callback failed', { reqId, sessionId, error: e.message });
            }
        }
    }

    /**
     * 快速失败: 上游明确要求长时间等待(额度耗尽/限流), 立即结束本次收集并尽力取消上游会话。
     * @param {object} info 归一化后的快速失败信息
     */
    function triggerFastFail(info) {
        if (fastFailInfo) return;
        fastFailInfo = info;
        /* 记录"为什么快速失败": reqId / nextInMs / message / elapsedMs / 原因, 便于线上排查 */
        logger.warn('[opencode] fast fail on upstream retry', {
            reqId,
            sessionId,
            nextInMs: info.nextInMs,
            retryAfterMs: info.retryAfterMs,
            message: info.message,
            reason: info.reason,
            keyword: info.keyword || null,
            attempt: info.attempt,
            elapsedMs: info.elapsedMs
        });
        resolveFastFail(info);
        finish({ fastFail: info }, 'fast-fail-retry');
        abortUpstreamSession();
    }

    /** 尽力让上游停止继续跑(opencode SDK 支持 session.abort; 不支持时只是日志说明) */
    function abortUpstreamSession() {
        const sessionAbort = client && client.session && client.session.abort;
        if (typeof sessionAbort !== 'function') {
            logger.warn('[opencode] SDK does not support session.abort, only stop waiting locally', { reqId, sessionId });
            return;
        }
        try {
            const params = { path: { id: sessionId } };
            if (directory) params.query = { directory };
            const result = sessionAbort.call(client.session, params);
            if (result && typeof result.then === 'function') {
                result.then((response) => {
                    if (response && response.error) {
                        logger.warn('[opencode] session abort returned error', { reqId, sessionId });
                    } else {
                        logger.info('[opencode] upstream session aborted (fast fail)', { reqId, sessionId });
                    }
                }).catch((e) => {
                    logger.warn('[opencode] session abort failed', { reqId, sessionId, error: e.message });
                });
            }
        } catch (e) {
            logger.warn('[opencode] session abort failed', { reqId, sessionId, error: e.message });
        }
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

    /** 缓存 messageID -> role; 只接受本会话的消息(返回缓存后的 role) */
    function cacheMessageRole(info) {
        if (!info || !info.id || !info.role) return null;
        if (info.sessionID && info.sessionID !== sessionId) return null;
        messageRoles.set(info.id, info.role);
        return info.role;
    }

    /**
     * 取消息角色; 未知时查一次 session.messages 回填(每请求每个新 messageID 只查一次).
     * 事件流本身有缓冲, 这里的 await 不会丢后续事件.
     * @param {string|null} messageID
     * @returns {Promise<string|null>} 'assistant' | 'user' | null(未知/查询失败)
     */
    async function resolveMessageRole(messageID) {
        if (!messageID) return null;
        if (messageRoles.has(messageID)) return messageRoles.get(messageID);
        if (roleLookups.has(messageID)) return messageRoles.get(messageID) || null;
        roleLookups.add(messageID);
        roleLookupCount += 1;
        try {
            const messagesRes = await client.session.messages({ path: { id: sessionId } });
            const messages = messagesRes?.data || messagesRes || [];
            if (Array.isArray(messages)) {
                messages.forEach((entry) => cacheMessageRole(entry?.info));
            }
        } catch (e) {
            // 查询失败不静默: 记录后保守跳过该 part, 不把来源不明的文本当 assistant 增量回显
            roleLookupFailed += 1;
            logger.debug('[opencode] message role lookup failed, skip unknown part', {
                reqId,
                sessionId,
                messageID,
                error: e.message
            });
        }
        return messageRoles.get(messageID) || null;
    }

    /**
     * 只有 assistant 消息的 text/reasoning part 允许进入增量;
     * user 消息(客户端注入的系统提示词/技能列表等)与未知来源一律跳过并记 debug.
     */
    async function handleRoleFilteredTextPart(part, properties) {
        const messageID = part.messageID || properties?.messageID || null;
        const role = await resolveMessageRole(messageID);
        if (settled) return;
        if (role !== 'assistant') {
            logger.debug('[opencode] skip non-assistant text part (not a delta)', {
                reqId,
                sessionId,
                messageID: messageID || null,
                role: role || 'unknown',
                type: part.type,
                chars: typeof part.text === 'string' ? part.text.length : 0
            });
            return;
        }
        handleTextPart(part, properties);
    }

    /* 差量化用的"上游原文"累计: 必须与实际下发内容分开, 否则输出过滤后 startsWith 判定会失效并重复 */
    let rawContent = '';
    let rawReasoning = '';

    function handleTextPart(part, properties) {
        const isReasoning = part.type === 'reasoning';
        /* opencode>=1.19 事件无 delta 字段, part.text 是该 part 当前全量文本, 按上游原文累计差量化出增量 */
        let delta = properties?.delta;
        if (!delta && typeof part.text === 'string') {
            const rawAccumulated = isReasoning ? rawReasoning : rawContent;
            delta = part.text.startsWith(rawAccumulated) ? part.text.slice(rawAccumulated.length) : part.text;
        }
        if (!delta) return;
        if (isReasoning) {
            rawReasoning += delta;
        } else {
            rawContent += delta;
        }

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

        /* 输出侧兜底: 命中系统注入标记的增量裁掉(不从上游原文累计里扣, 差量化仍按原文走) */
        const filter = isReasoning ? reasoningEchoFilter : contentEchoFilter;
        const filtered = filter.filter(delta);
        if (filtered) applyDelta(filtered, isReasoning);
    }

    function handleMessageUpdated(event) {
        const info = event.properties?.info;
        if (!info || info.sessionID !== sessionId) return;
        /* 先落角色缓存: part 事件先到/后到都能据此判断, 避免 user part 混进增量 */
        cacheMessageRole(info);
        const role = messageRoles.get(info.id) || null;
        /* role 缺失时保持旧行为(assistant); 明确是 user 的消息不参与错误/结束判定 */
        if (role && role !== 'assistant') {
            logger.debug('[opencode] user message updated (ignored for streaming)', {
                reqId,
                sessionId,
                messageID: info.id || null
            });
            return;
        }
        if (info.error) {
            state.assistantError = info.error;
            logger.error('[opencode] assistant error event', {
                reqId,
                sessionId,
                errorName: info.error.name || null,
                errorMessage: previewText(info.error.data?.message || info.error.message, 300)
            });
        }
        /*
         * 本轮结束判定(与上游 loop 一致):
         * - 中间 step 的 finish=tool-calls/unknown 不是结束, 上游会继续跑并写新的 assistant 消息;
         * - 终态 finish(stop/length/...)或 error 才是结束, 收集器立刻结束, 交给调用方收尾。
         */
        if (info.error || isTerminalAssistantFinish(info.finish)) {
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
            const normalized = normalizeRetryStatus(status);
            const decision = decideFastFail({
                nextInMs: normalized.nextInMs,
                message: normalized.message,
                fastFailRetryMs
            });
            logger.warn('[opencode] session retry (upstream throttling/overload)', {
                reqId,
                sessionId,
                attempt: normalized.attempt,
                rateLimited: retry.rateLimited,
                retryAfter: retry.retryAfter,
                nextInMs: normalized.nextInMs,
                message: retry.message,
                fastFail: decision.shouldFail,
                fastFailReason: decision.reason,
                fastFailKeyword: decision.keyword
            });
            if (decision.shouldFail) {
                triggerFastFail({
                    nextInMs: decision.nextInMs,
                    retryAfterMs: decision.retryAfterMs,
                    message: retry.message,
                    reason: decision.reason,
                    keyword: decision.keyword,
                    attempt: normalized.attempt,
                    elapsedMs: Date.now() - startedAt
                });
            }
            return;
        }
        logger.debug('[opencode] session status', { reqId, sessionId, status: status.type });
    }

    /** 上报活动(事件/增量), 供在途注册表计算 idleMs 与进度日志 */
    function notifyActivity(type) {
        if (!onActivity) return;
        try {
            onActivity({ type: type || 'unknown', events: state.events, deltaChars: state.deltaChars });
        } catch (e) {
            logger.warn('[opencode] onActivity callback failed', { reqId, sessionId, error: e.message });
        }
    }

    async function consume(stream) {
        for await (const event of stream) {
            if (settled) break;
            state.events += 1;
            const type = event?.type;
            notifyActivity(type);
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
                await handleRoleFilteredTextPart(part, event.properties);
                if (settled) break;
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
            if (type === 'session.error') {
                /* 提交期/生成期失败(如 provider 鉴权、模型不存在)可能没有可轮询的 assistant 消息,
                   必须在这里结束收集, 否则 promptAsync 路径会一直轮询到总超时 */
                const properties = event.properties || {};
                /* 只认本会话: 全局事件流里可能有别的会话/没有 sessionID 的错误, 不能算到当前请求头上 */
                if (properties.sessionID !== sessionId) continue;
                const sessionError = properties.error || null;
                state.assistantError = sessionError;
                logger.error('[opencode] session error event', {
                    reqId,
                    sessionId,
                    errorName: sessionError?.name || null,
                    errorMessage: previewText(sessionError?.data?.message || sessionError?.message, 300)
                });
                finish({ error: sessionError || new Error('OpenCode session error'), sessionError: true }, 'session-error');
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
        /* 快速失败信号: 触发后 resolve(info); 未触发时永远 pending(proxy 用它 race, 不占定时器) */
        fastFailPromise,
        getFastFail: () => fastFailInfo,
        state,
        abort: () => finish({ aborted: true }, 'aborted')
    };
}
