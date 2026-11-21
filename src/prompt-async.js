/**
 * promptAsync 提交 + 本轮完成等待(opencode-to-openai 网关)
 *
 * 背景(线上故障): session.prompt 会一直占着一条 HTTP 连接等模型把整轮跑完, 而 Node 内置
 * fetch(undici)的 headersTimeout/bodyTimeout 默认是 300 秒, 长任务(如 bash 里 sleep 360)
 * 会在 300.6 秒被底层掐断, 报 "fetch failed"; 这与网关的 REQUEST_TIMEOUT_MS(默认 30 分钟)无关。
 *
 * 修复后的两段式:
 * 1) 提交: session.promptAsync(服务端 204 立即返回, 后台继续跑), 不再占用长连接;
 * 2) 等待完成: 优先用 SSE 事件收集器(collectSessionEvents)的完成信号, SSE 空闲超时/断流/
 *    首包超时时用 session.messages 轮询兜底, 直到 assistant 本轮真正到终态。
 *    提交与等待共用同一个总超时预算(REQUEST_TIMEOUT_MS), 不会叠成两倍。
 *
 * 完成判定与上游一致(opencode v1.1.53 session/prompt.ts):
 * - 上游每一轮(step)会新建一条 assistant 消息, 中间步骤 finish=tool-calls,
 *   只有最后一条的 finish 存在且不是 tool-calls/unknown 时, 本轮才算结束;
 * - assistant 消息带 error 也是终态(provider 报错不会再产生 finish)。
 */

import { UpstreamRetryError, waitForPrompt } from './retry-guard.js';
import { extractFromParts, isTerminalAssistantFinish } from './opencode-events.js';

/** 轮询间隔(毫秒): 与旧实现保持一致 */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * assistant 消息是否已到本轮终态
 * - error: 上游 provider 报错(不会再产生 finish)
 * - finish 存在且不是 tool-calls/unknown: 上游 loop 的退出条件
 * @param {object|null|undefined} info assistant message.info
 * @returns {boolean}
 */
export function isAssistantMessageDone(info) {
    if (!info) return false;
    if (info.error) return true;
    return isTerminalAssistantFinish(info.finish);
}

/** 简版 sleep(测试可注入 wait 替换) */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 提交提示词: 用 session.promptAsync 取代会长期占用连接的 session.prompt。
 * promptAsync 只负责"已受理"(服务端 204), 出错(HTTP/参数/模型不存在等同步失败)按原错误路径抛出。
 *
 * @param {object} client opencode SDK client
 * @param {object} promptParams { path: {id}, body, query? } 与 session.prompt 完全一致
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 提交阶段可用的剩余超时(总预算的一部分)
 * @param {Promise<object>|null} [options.fastFailPromise] collector.fastFailPromise
 * @param {string|null} [options.reqId] 网关请求 id
 * @param {object|null} [options.logger] 日志器
 * @returns {Promise<object>} SDK 结果
 */
export async function submitPromptAsync(client, promptParams, options = {}) {
    const {
        timeoutMs = 1800000,
        fastFailPromise = null,
        reqId = null,
        logger = null
    } = options;
    const session = client && client.session;
    if (!session || typeof session.promptAsync !== 'function') {
        /* 不回退到 session.prompt: 那条路径会重新引入 300 秒 fetch 超时故障 */
        throw new Error('opencode SDK does not support session.promptAsync (requires @opencode-ai/sdk >= 1.1.53); refusing to fall back to session.prompt which breaks long tasks at ~300s');
    }
    const startedAt = Date.now();
    const result = await waitForPrompt(
        Promise.resolve(session.promptAsync(promptParams)),
        timeoutMs,
        fastFailPromise
    );
    /* promptAsync 是短调用: 受理失败(4xx/5xx)必须走原有上游错误路径 */
    if (result && result.error) {
        let errorText;
        if (typeof result.error === 'string') {
            errorText = result.error;
        } else {
            try {
                errorText = JSON.stringify(result.error).slice(0, 300);
            } catch (e) {
                errorText = `[unserializable error: ${e.message}]`;
            }
        }
        const error = new Error(`Send prompt failed: ${errorText}`);
        error.status = result.response?.status ?? null;
        error.responseBody = result.error;
        throw error;
    }
    if (logger && typeof logger.debug === 'function') {
        logger.debug('[Proxy] promptAsync accepted', { reqId, ms: Date.now() - startedAt });
    }
    return result;
}

/**
 * 轮询最近一条 assistant 消息, 直到本轮完成(requireDone=true)或拿到内容(旧语义)。
 *
 * requireDone 语义(新主流程): 只看 **最后一条消息**; 只有它已经到 assistant 终态才返回。
 * 中间步骤(tool-calls)或还停在 user 消息时继续等 —— 上游会继续用同一会话跑完并写新的 assistant 消息。
 *
 * 旧语义(requireDone=false, 保留给"取全文"兜底): 从最新往前找 assistant, 有内容/finish 即返回。
 *
 * @param {object} options
 * @param {object} options.client opencode SDK client
 * @param {string} options.sessionId 会话 id
 * @param {number} options.timeoutMs 本次轮询可用的剩余超时(毫秒)
 * @param {number} [options.intervalMs] 轮询间隔
 * @param {string|null} [options.reqId] 网关请求 id
 * @param {Function|null} [options.getFastFail] collector.getFastFail, 轮询期间收到快速失败立即抛 UpstreamRetryError
 * @param {Function|null} [options.sanitize] (text, channel) => string 输出侧回显裁剪
 * @param {object|null} [options.logger] 日志器
 * @param {boolean} [options.requireDone] true=必须等到 assistant 终态
 * @param {AbortSignal|null} [options.signal] 取消信号(调用方已拿到别的结论时停止轮询)
 * @param {Function} [options.now] 时钟(测试注入)
 * @param {Function} [options.wait] sleep(测试注入)
 * @returns {Promise<{content: string, reasoning: string, error: object|null, done: boolean}>}
 */
export async function pollForAssistantResponse(options) {
    const {
        client,
        sessionId,
        timeoutMs,
        intervalMs = DEFAULT_POLL_INTERVAL_MS,
        reqId = null,
        getFastFail = null,
        sanitize = null,
        logger = null,
        requireDone = false,
        signal = null,
        now = Date.now,
        wait = sleep
    } = options;

    const pollStart = now();
    let incompleteLogged = false;

    while (!(signal && signal.aborted) && now() - pollStart < timeoutMs) {
        const fastFailInfo = getFastFail ? getFastFail() : null;
        if (fastFailInfo) {
            throw new UpstreamRetryError(fastFailInfo);
        }
        const messagesRes = await client.session.messages({ path: { id: sessionId } });
        const messages = messagesRes?.data || messagesRes || [];
        if (Array.isArray(messages) && messages.length) {
            if (requireDone) {
                /* 只看最后一条: 上一轮 step 结束后上游才会写新的 assistant 消息, 不能回退取更早的旧消息 */
                const entry = messages[messages.length - 1];
                const info = entry?.info;
                if (info?.role === 'assistant' && isAssistantMessageDone(info)) {
                    const read = readAssistantEntry(entry, sanitize);
                    logPollCompleted(logger, { reqId, sessionId, ms: now() - pollStart, done: true, read });
                    return { content: read.content, reasoning: read.reasoning, error: read.error, done: true };
                }
                if (!incompleteLogged) {
                    incompleteLogged = true;
                    if (logger && typeof logger.debug === 'function') {
                        logger.debug('[Proxy] Assistant not finished yet, keep polling', {
                            reqId,
                            sessionId,
                            role: info?.role || null,
                            finish: info?.finish || null
                        });
                    }
                }
            } else {
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const read = readAssistantEntry(entry, sanitize);
                    /* 旧语义: 有 finish/完成时间, 或有内容即返回(非流式取全文兜底) */
                    if (read.done || read.content || read.reasoning) {
                        logPollCompleted(logger, { reqId, sessionId, ms: now() - pollStart, done: read.done, read });
                        return { content: read.content, reasoning: read.reasoning, error: read.error, done: read.done };
                    }
                }
            }
        }
        await wait(intervalMs);
    }
    if (signal && signal.aborted) {
        throw new Error('Polling aborted');
    }
    if (logger && typeof logger.debug === 'function') {
        logger.debug('Polling timeout', { reqId, sessionId, ms: now() - pollStart });
    }
    throw new Error(`Request timeout after ${timeoutMs}ms`);
}

/**
 * 读一条 assistant 消息的正文/推理/错误
 * @param {object} entry messages 里的 {info, parts}
 * @param {Function|null} sanitize 输出侧裁剪
 * @returns {{content: string, reasoning: string, error: object|null, done: boolean}}
 */
function readAssistantEntry(entry, sanitize) {
    const info = entry?.info || {};
    const raw = extractFromParts(entry?.parts || []);
    const apply = typeof sanitize === 'function' ? sanitize : (text) => text;
    return {
        content: apply(raw.content, 'content'),
        reasoning: apply(raw.reasoning, 'reasoning'),
        error: info.error || null,
        /* 旧语义下的"已结束": 有 finish / 完成时间 / error 任一 */
        done: Boolean(info.finish || info.time?.completed || info.error)
    };
}

/** 轮询命中日志(与旧实现字段保持一致) */
function logPollCompleted(logger, { reqId, sessionId, ms, done, read }) {
    if (!logger) return;
    if (read.error && typeof logger.error === 'function') {
        logger.error('[Proxy] OpenCode assistant error:', { reqId, sessionId, error: read.error });
    }
    if (typeof logger.debug === 'function') {
        logger.debug('Polling completed', {
            reqId,
            sessionId,
            ms,
            done,
            contentLen: read.content.length,
            reasoningLen: read.reasoning.length,
            error: read.error ? read.error.name : null
        });
    }
}
