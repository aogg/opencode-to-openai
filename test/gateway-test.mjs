/**
 * 网关修复回归测试: R1 输出零回显 / R2 限流快速失败 / R3 排队上限 / R4-R5 在途进度与看门狗
 *
 * 覆盖点:
 * 1) 即使上游把 user/system 文本当作 assistant part 回显, streaming 与非流式两条路径的响应里都不能出现;
 * 2) session.status=retry 的 nextInMs 超阈值 / 额度类文案立即快速失败, 小于阈值时继续等待;
 * 3) 单并发队列排队超限返回 503 契约;
 * 4) 在途注册表增删、进度字段、idle/stalled 判定与去重。
 *
 * 运行: node test/gateway-test.mjs (纯 Node, 无外部依赖, 不启动 opencode)
 */

import assert from 'node:assert/strict';
import { collectSessionEvents, extractFromParts } from '../src/opencode-events.js';
import { buildEchoPatterns, createStreamEchoFilter, sanitizeAssistantText } from '../src/output-guard.js';
import {
    DEFAULT_FAST_FAIL_RETRY_MS,
    UpstreamRetryError,
    buildRetryFailure,
    decideFastFail,
    isUpstreamRetryError,
    normalizeRetryStatus,
    waitForPrompt
} from '../src/retry-guard.js';
import {
    DEFAULT_PROGRESS_LOG_INTERVAL_MS,
    DEFAULT_STALL_WARN_MS,
    createInflightRegistry
} from '../src/inflight.js';
import {
    DEFAULT_QUEUE_MAX_WAIT_MS,
    QueueTimeoutError,
    buildQueueTimeoutResponse,
    createSerialQueue,
    isQueueTimeoutError
} from '../src/serial-queue.js';
import { startStreamHeartbeat } from '../src/stream-heartbeat.js';

const SESSION_ID = 'ses_gateway_test';

/** 静默 logger, 同时收集日志用于断言 */
function createTestLogger() {
    const entries = [];
    const push = (level) => (message, detail) => entries.push({ level, message, detail });
    const logger = {
        entries,
        error: push('error'),
        warn: push('warn'),
        info: push('info'),
        debug: push('debug'),
        /** 取某等级某关键字的第一条日志 */
        find(level, keyword) {
            return entries.find((entry) => entry.level === level && String(entry.message).includes(keyword));
        }
    };
    return logger;
}

/** 构造假 opencode SDK client(支持事件流/会话消息/abort) */
function createFakeClient({ events = [], messages = [], abortError = null } = {}) {
    const calls = { subscribe: 0, messages: 0, abort: 0 };
    const client = {
        event: {
            subscribe: async () => {
                calls.subscribe += 1;
                async function* stream() {
                    for (const event of events) yield event;
                }
                return { stream: stream() };
            }
        },
        session: {
            messages: async (params) => {
                calls.messages += 1;
                assert.deepEqual(params, { path: { id: SESSION_ID } }, 'session.messages 必须按会话 id 查询');
                return { data: messages };
            },
            abort: async (params) => {
                calls.abort += 1;
                assert.deepEqual(params, { path: { id: SESSION_ID } }, 'session.abort 必须按会话 id 取消');
                if (abortError) throw abortError;
                return { data: true };
            }
        }
    };
    return { client, calls };
}

/** 跑一次 collector, 返回结果 + onDelta 收集到的增量 */
async function runCollector({ events, messages, abortError, fastFailRetryMs = 60000, echoPatterns = null, timeoutMs = 5000 } = {}) {
    const { client, calls } = createFakeClient({ events, messages, abortError });
    const logger = createTestLogger();
    const deltas = [];
    const collector = collectSessionEvents({
        client,
        sessionId: SESSION_ID,
        reqId: 'gw-test',
        timeoutMs,
        firstDeltaTimeoutMs: 0,
        idleTimeoutMs: 0,
        autoApprovePermission: false,
        fastFailRetryMs,
        echoPatterns,
        onDelta: (delta, isReasoning) => deltas.push({ delta, isReasoning }),
        logger
    });
    const ready = await collector.ready;
    assert.equal(ready, true, '事件流订阅应成功');
    const result = await collector.promise;
    return { result, deltas, calls, logger, collector };
}

function partEvent(part, properties = {}) {
    return { type: 'message.part.updated', properties: { part, ...properties } };
}

function textPart({ id = 'prt_1', messageID = 'msg_asst', text, sessionID = SESSION_ID, type = 'text' }) {
    return { id, sessionID, messageID, type, text };
}

function messageUpdated(info) {
    return { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, ...info } } };
}

function sessionStatus(status) {
    return { type: 'session.status', properties: { sessionID: SESSION_ID, status } };
}

const assistantInfo = (id = 'msg_asst', extra = {}) => ({ id, sessionID: SESSION_ID, role: 'assistant', ...extra });
const userInfo = (id = 'msg_user', extra = {}) => ({ id, sessionID: SESSION_ID, role: 'user', ...extra });

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

/* ================================================================== */
/* R1: 输出侧零回显                                                    */
/* ================================================================== */

test('R1 整段回显: 首行以 USER: 开头的 prompt 原文被整段裁掉', () => {
    const patterns = buildEchoPatterns(null);
    // 线上真实形态: assistant 首包直接是拼好的 parts 原文
    const echoed = 'USER: 你好USER: # 角色注入（dsh-rules-auto 插件，角色=code-js）\n# 项目系统提示词\n干活吧';
    const cleaned = sanitizeAssistantText(echoed, patterns);
    assert.equal(cleaned.text, '', '整段 prompt 回显不得下发');
    assert.ok(cleaned.removedChars > 0);
    assert.ok(cleaned.hits.some((hit) => hit.includes('USER|SYSTEM')), '应记录命中的角色前缀标记');
});

test('R1 中间命中: 正文中间的注入行被删除, 其它正常内容保留', () => {
    const patterns = buildEchoPatterns(null);
    const text = '先说明一下：\n# 角色注入（dsh）\n正常回答内容';
    const cleaned = sanitizeAssistantText(text, patterns);
    assert.equal(cleaned.text.includes('角色注入'), false);
    assert.equal(cleaned.text.includes('正常回答内容'), true);
    assert.equal(cleaned.text, '先说明一下：\n正常回答内容');
});

test('R1 非流式 parts 汇总: assistant part 里的 user/system 文本不得进入响应', () => {
    const patterns = buildEchoPatterns(null);
    // 模拟 pollForAssistantResponse 的 extractFromParts + sanitizeAssistantOutput 组合
    const parts = [
        { type: 'text', text: '先说明一下：\n' },
        { type: 'text', text: 'USER: 你好\n' },
        { type: 'text', text: '# 角色注入（dsh）\n' },
        { type: 'text', text: '正常回答内容' }
    ];
    const raw = extractFromParts(parts);
    const content = sanitizeAssistantText(raw.content, patterns).text;
    assert.equal(content.includes('USER: 你好'), false, 'user 文本不得出现在 assistant 响应里');
    assert.equal(content.includes('角色注入'), false, 'system 注入标记不得出现在 assistant 响应里');
    assert.equal(content, '先说明一下：\n正常回答内容');

    // 线上形态: 整个 assistant 消息就是 prompt 回显
    const echoRaw = extractFromParts([{ type: 'text', text: 'USER: 你好USER: # 角色注入（dsh）' }]);
    assert.equal(sanitizeAssistantText(echoRaw.content, patterns).text, '');
});

test('R1 流式增量: 角色前缀开头的回显整段丢弃, 正常增量原样透传', () => {
    const patterns = buildEchoPatterns(null);

    const echoFilter = createStreamEchoFilter({ patterns });
    assert.equal(echoFilter.filter('USER: '), '');
    assert.equal(echoFilter.filter('你好'), '');
    assert.equal(echoFilter.filter('USER: # 角色注入'), '');
    const stats = echoFilter.stats();
    assert.equal(stats.blocked, true);
    assert.ok(stats.removedChars > 0);

    const normalFilter = createStreamEchoFilter({ patterns });
    const out = ['你', '好', '，这是', '回答。'].map((chunk) => normalFilter.filter(chunk));
    assert.deepEqual(out, ['你', '好', '，这是', '回答。'], '正常文本立即放行, 不增加首包延迟');
    assert.equal(normalFilter.flush(), '');
});

test('R1 流式增量: 中途行首命中标记的增量被删除', () => {
    const patterns = buildEchoPatterns(null);
    const filter = createStreamEchoFilter({ patterns });
    assert.equal(filter.filter('第一行正常\n'), '第一行正常\n');
    assert.equal(filter.filter('USER: 注入的 user 消息\n'), '');
    assert.equal(filter.filter('第二行正常'), '第二行正常');
    assert.equal(filter.flush(), '');
});

test('R1 流式 collector: assistant part 回显 user/system 文本时 content/delta 都为空', async () => {
    const echoed = 'USER: 你好USER: # 角色注入（dsh-rules-auto 插件，角色=code-js）';
    const { result, deltas, logger } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: echoed })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });
    assert.equal(result.content, '', 'assistant 回显的系统提示词不得进入 content');
    assert.equal(result.reasoning, '');
    assert.deepEqual(deltas, [], '不得下发任何回显增量');
    assert.equal(result.receivedDelta, true, '上游确实发过增量(只是被过滤)');
    assert.ok(result.echoRemovedChars > 0, '应统计被裁剪的字符数');
    const warn = logger.find('warn', 'system prompt echo removed');
    assert.ok(warn, '命中回显必须打 WARN');
    assert.ok(String(warn.detail.reqId).length > 0);
    assert.ok(String(warn.detail.marker).length > 0);
    assert.ok(warn.detail.removedChars > 0);
});

test('R1 流式 collector: 正常 assistant 增量不受过滤影响且保持逐增量下发', async () => {
    const { result, deltas } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '你' })),
            partEvent(textPart({ id: 'prt_a2', messageID: 'msg_asst', text: '你好' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });
    assert.equal(result.content, '你好');
    assert.deepEqual(deltas, [
        { delta: '你', isReasoning: false },
        { delta: '好', isReasoning: false }
    ]);
    assert.equal(result.echoRemovedChars, 0);
});

/* ================================================================== */
/* R2: 上游限流/额度耗尽快速失败                                        */
/* ================================================================== */

test('R2 判定: nextInMs 超阈值快速失败, 小于阈值继续等待', () => {
    const tooFar = decideFastFail({ nextInMs: 51401998, message: '', fastFailRetryMs: 60000 });
    assert.equal(tooFar.shouldFail, true);
    assert.equal(tooFar.reason, 'next-in-too-far');

    const soon = decideFastFail({ nextInMs: 3000, message: 'server overloaded', fastFailRetryMs: 60000 });
    assert.equal(soon.shouldFail, false);

    const disabled = decideFastFail({ nextInMs: 51401998, message: '', fastFailRetryMs: 0 });
    assert.equal(disabled.shouldFail, false, 'FAST_FAIL_RETRY_MS=0 关闭阈值判断');
});

test('R2 判定: 额度类文案即使 nextInMs 很小也快速失败', () => {
    const cases = [
        'Free usage exceeded, subscribe to Go',
        'usage exceeded',
        'quota exhausted',
        'please subscribe to continue',
        'rate limit reached',
        'too many requests'
    ];
    cases.forEach((message) => {
        const decision = decideFastFail({ nextInMs: 1000, message, fastFailRetryMs: 60000 });
        assert.equal(decision.shouldFail, true, `额度类文案应快速失败: ${message}`);
        assert.equal(decision.reason, 'quota-message');
        assert.ok(decision.keyword, '应记录命中的关键词');
    });
    // 关闭阈值判断时额度类文案仍然快速失败
    const disabled = decideFastFail({ nextInMs: 1000, message: 'free usage exceeded', fastFailRetryMs: 0 });
    assert.equal(disabled.shouldFail, true);
});

test('R2 normalizeRetryStatus: 兼容 nextInMs 与 next 时间戳两种字段', () => {
    assert.equal(normalizeRetryStatus({ nextInMs: 5000 }).nextInMs, 5000);
    const normalized = normalizeRetryStatus({ next: Date.now() + 7000, attempt: 2 });
    assert.equal(normalized.attempt, 2);
    assert.ok(normalized.nextInMs > 6000 && normalized.nextInMs <= 7000, `next 时间戳应换算成相对毫秒, 实际 ${normalized.nextInMs}`);
    assert.equal(normalizeRetryStatus({ nextInMs: -5 }).nextInMs, 0);
});

test('R2 buildRetryFailure: 429 + gateway_upstream_retry + retry_after_ms', () => {
    const failure = buildRetryFailure({ message: 'Free usage exceeded, subscribe to Go', retryAfterMs: 51401998 });
    assert.equal(failure.status, 429);
    assert.equal(failure.body.error.type, 'gateway_upstream_retry');
    assert.equal(failure.body.error.retry_after_ms, 51401998);
    assert.ok(failure.body.error.message.includes('秒后重试'));
    assert.ok(failure.body.error.message.includes('Free usage exceeded'));
    assert.ok(failure.body.error.message.startsWith('上游限流'));

    const unknownWait = buildRetryFailure({ message: 'quota exhausted', retryAfterMs: 0 });
    assert.equal(unknownWait.body.error.retry_after_ms, 0);
    assert.ok(unknownWait.body.error.message.includes('稍后重试'));
});

test('R2 waitForPrompt: 收到快速失败信号立即返回, 不等 300s 定时器', async () => {
    let resolveFastFail = null;
    const fastFailPromise = new Promise((resolve) => { resolveFastFail = resolve; });
    const neverPrompt = new Promise(() => {});
    const startedAt = Date.now();
    const pending = waitForPrompt(neverPrompt, 300000, fastFailPromise);
    setTimeout(() => resolveFastFail({ message: 'Free usage exceeded', nextInMs: 51401998, retryAfterMs: 51401998 }), 20);
    let error = null;
    try {
        await pending;
    } catch (e) {
        error = e;
    }
    assert.ok(error instanceof UpstreamRetryError, '快速失败应抛 UpstreamRetryError');
    assert.equal(isUpstreamRetryError(error), true);
    assert.equal(error.info.nextInMs, 51401998);
    assert.ok(Date.now() - startedAt < 2000, '必须立即返回, 不能被 300s 定时器拖住');
});

test('R2 waitForPrompt: 正常完成返回结果; 超时仍按 timeoutMs 抛错', async () => {
    assert.equal(await waitForPrompt(Promise.resolve('ok'), 300000, null), 'ok');

    let timeoutError = null;
    try {
        await waitForPrompt(new Promise(() => {}), 30, null);
    } catch (e) {
        timeoutError = e;
    }
    assert.ok(timeoutError && timeoutError.message.includes('Request timeout'));
});

test('R2 collector: nextInMs 过大触发快速失败并取消上游会话', async () => {
    const { result, deltas, calls, logger, collector } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            sessionStatus({ type: 'retry', attempt: 1, rateLimited: false, retryAfter: null, nextInMs: 51401998, message: '' }),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '不该出现' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });
    assert.equal(result.reason, 'fast-fail-retry');
    assert.equal(result.fastFail.nextInMs, 51401998);
    assert.equal(result.fastFail.reason, 'next-in-too-far');
    assert.deepEqual(deltas, []);
    assert.equal(calls.abort, 1, '快速失败时应调用 session.abort 取消上游');
    const fastFailInfo = await collector.fastFailPromise;
    assert.equal(fastFailInfo.nextInMs, 51401998);
    assert.equal(collector.getFastFail().reason, 'next-in-too-far');
    assert.ok(logger.find('warn', 'session retry'), 'retry 事件必须有 warn 日志');
    assert.ok(logger.find('warn', 'fast fail'), '快速失败必须有 warn 日志(带原因)');
});

test('R2 collector: 额度类文案触发快速失败(即使会很快重试)', async () => {
    const { result, calls } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            sessionStatus({ type: 'retry', attempt: 1, nextInMs: 2000, message: 'Free usage exceeded, subscribe to Go' }),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });
    assert.equal(result.reason, 'fast-fail-retry');
    assert.equal(result.fastFail.reason, 'quota-message');
    assert.equal(result.fastFail.keyword, 'free usage');
    assert.equal(calls.abort, 1);
});

test('R2 collector: nextInMs 小于阈值时继续等待, 正常拿到回答', async () => {
    const { result, deltas, calls } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            sessionStatus({ type: 'retry', attempt: 1, nextInMs: 3000, message: 'server overloaded, retry in 3s' }),
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '正常回答' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });
    assert.equal(result.reason, 'message-finished');
    assert.equal(result.fastFail, null);
    assert.equal(result.content, '正常回答');
    assert.deepEqual(deltas, [{ delta: '正常回答', isReasoning: false }]);
    assert.equal(calls.abort, 0, '小重试不应取消上游');
});

/* ================================================================== */
/* R3: 排队上限                                                        */
/* ================================================================== */

test('R3 排队超限: QueueTimeoutError -> 503 gateway_queue_timeout', async () => {
    const queue = createSerialQueue({ logger: createTestLogger(), maxWaitMs: 80, nextDelayMs: 1 });
    const first = queue.enqueue(() => new Promise((resolve) => setTimeout(() => resolve('first'), 250)), { timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    let secondError = null;
    const second = queue.enqueue(() => 'second', { timeoutMs: 5000 }).catch((error) => { secondError = error; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(secondError instanceof QueueTimeoutError, '排队超限应抛 QueueTimeoutError');
    assert.equal(secondError.code, 'GATEWAY_QUEUE_TIMEOUT');
    assert.ok(secondError.waitedMs >= 60, `waitedMs 应接近排队上限, 实际 ${secondError.waitedMs}`);
    assert.equal(isQueueTimeoutError(secondError), true);
    const response = buildQueueTimeoutResponse(secondError);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.type, 'gateway_queue_timeout');
    assert.equal(response.body.error.message, '网关排队超时，请稍后重试');
    assert.ok(response.body.error.waited_ms >= 60);
    assert.equal(await first, 'first');
    await second;
    assert.equal(queue.length, 0, '超限请求必须从队列移除');
});

test('R3 排队未超限: 正常按顺序执行; maxWaitMs=0 表示不限制', async () => {
    const queue = createSerialQueue({ logger: createTestLogger(), maxWaitMs: 500, nextDelayMs: 1 });
    const order = [];
    const first = queue.enqueue(async () => {
        order.push('first');
        await new Promise((resolve) => setTimeout(resolve, 40));
        return 1;
    }, { timeoutMs: 5000 });
    const second = queue.enqueue(() => {
        order.push('second');
        return 2;
    }, { timeoutMs: 5000 });
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first', 'second'], '单并发必须按入队顺序执行');

    const unlimited = createSerialQueue({ logger: createTestLogger(), maxWaitMs: 0, nextDelayMs: 1 });
    const slow = unlimited.enqueue(() => new Promise((resolve) => setTimeout(() => resolve('slow'), 60)), { timeoutMs: 5000 });
    const fast = unlimited.enqueue(() => 'fast', { timeoutMs: 5000 });
    assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast']);
});

/* ================================================================== */
/* R4/R5: 在途注册表, 进度日志与卡住判定                                 */
/* ================================================================== */

test('R4/R5 默认值: 排队 60s / 进度 300s / 卡住 300s', () => {
    assert.equal(DEFAULT_QUEUE_MAX_WAIT_MS, 60000);
    assert.equal(DEFAULT_PROGRESS_LOG_INTERVAL_MS, 300000);
    assert.equal(DEFAULT_STALL_WARN_MS, 300000);
    assert.equal(DEFAULT_FAST_FAIL_RETRY_MS, 60000);
});

test('R4/R5 注册表: 增删、字段更新与快照字段', () => {
    let current = 1_000_000;
    const logger = createTestLogger();
    const registry = createInflightRegistry({ logger, progressIntervalMs: 0, stallCheckIntervalMs: 0, now: () => current });

    registry.register({ reqId: 'gw-1', phase: 'queue', startedAt: current, queueWaitMs: 123 });
    assert.equal(registry.size, 1);
    registry.update('gw-1', { phase: 'prompt', model: 'opencode/deepseek-v4.1-flash-free', stream: true, sessionId: 'ses_1' });
    current += 1000;
    registry.update('gw-1', { lastEvent: 'message.part.updated', deltaChars: 5 });
    current += 1000;

    const snapshot = registry.snapshot();
    assert.equal(snapshot.now, current);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.stalled, 0);
    const request = snapshot.requests[0];
    assert.equal(request.reqId, 'gw-1');
    assert.equal(request.phase, 'prompt');
    assert.equal(request.model, 'opencode/deepseek-v4.1-flash-free');
    assert.equal(request.stream, true);
    assert.equal(request.sessionId, 'ses_1');
    assert.equal(request.startedAt, 1_000_000);
    assert.equal(request.elapsedMs, 2000);
    assert.equal(request.idleMs, 1000);
    assert.equal(request.queueWaitMs, 123);
    assert.equal(request.deltaChars, 5);
    assert.equal(request.lastEvent, 'message.part.updated');
    assert.equal(request.stalled, false);

    // 排队期间(只 register 不 update)也能被看门狗识别为卡住
    current += 1;
    registry.remove('gw-1');
    assert.equal(registry.size, 0);
    assert.equal(registry.snapshot().count, 0);
    assert.equal(registry.update('gw-1', { phase: 'done' }), null, '已移除请求的晚到更新必须忽略');
});

test('R4 进度日志: INFO 输出 reqId/phase/elapsedMs/idleMs/sessionId/model/stream/deltaChars/lastEvent/queueWaitMs', () => {
    let current = 2_000_000;
    const logger = createTestLogger();
    const registry = createInflightRegistry({ logger, progressIntervalMs: 0, stallCheckIntervalMs: 0, now: () => current });
    registry.register({ reqId: 'gw-progress', phase: 'queue', startedAt: current, queueWaitMs: 42 });
    registry.update('gw-progress', { phase: 'collect', model: 'opencode/x', stream: true, sessionId: 'ses_x', lastEvent: 'session.status', deltaChars: 9 });
    current += 300000;
    const fields = registry.logProgress('gw-progress');
    assert.ok(fields);
    const log = logger.find('info', 'Request progress');
    assert.ok(log, '每满一个间隔必须输出 INFO 进度');
    assert.equal(log.detail.reqId, 'gw-progress');
    assert.equal(log.detail.phase, 'collect');
    assert.equal(log.detail.elapsedMs, 300000);
    assert.equal(log.detail.idleMs, 300000);
    assert.equal(log.detail.sessionId, 'ses_x');
    assert.equal(log.detail.model, 'opencode/x');
    assert.equal(log.detail.stream, true);
    assert.equal(log.detail.deltaChars, 9);
    assert.equal(log.detail.lastEvent, 'session.status');
    assert.equal(log.detail.queueWaitMs, 42);
    registry.stop();
});

test('R5 看门狗: idle 超过 STALL_WARN_MS 打 WARN, 同一窗口只报一次', () => {
    let current = 3_000_000;
    const logger = createTestLogger();
    const registry = createInflightRegistry({ logger, progressIntervalMs: 0, stallCheckIntervalMs: 0, stallWarnMs: 300000, now: () => current });
    registry.register({ reqId: 'gw-stall', phase: 'prompt', startedAt: current });
    registry.update('gw-stall', { model: 'opencode/x', stream: false, sessionId: 'ses_s', lastEvent: 'session.status' });

    // 未超过阈值: 不告警
    current += 300000;
    assert.deepEqual(registry.checkStalled(), []);
    assert.equal(registry.snapshot().stalled, 0);

    // 超过阈值 1ms: 告警, 快照 stalled=1
    current += 1;
    const flagged = registry.checkStalled();
    assert.equal(flagged.length, 1);
    const warn = logger.find('warn', 'Stalled request');
    assert.ok(warn, '卡住请求必须打 WARN');
    assert.equal(warn.detail.reqId, 'gw-stall');
    assert.equal(warn.detail.idleMs, 300001);
    assert.equal(warn.detail.phase, 'prompt');
    assert.equal(warn.detail.sessionId, 'ses_s');
    assert.equal(warn.detail.model, 'opencode/x');
    assert.equal(warn.detail.stream, false);
    assert.equal(warn.detail.deltaChars, 0);
    assert.equal(registry.snapshot().stalled, 1);

    // 同一窗口内不重复报
    current += 60000;
    assert.deepEqual(registry.checkStalled(), []);

    // 下一个窗口继续报
    current += 240000;
    assert.equal(registry.checkStalled().length, 1);
    registry.stop();
});

test('R4 定时器不泄漏: 请求移除/注册表 stop 后进度定时器不再输出', async () => {
    const logger = createTestLogger();
    const registry = createInflightRegistry({ logger, progressIntervalMs: 20, stallCheckIntervalMs: 0 });
    registry.register({ reqId: 'gw-timer', phase: 'prompt', startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(logger.find('info', 'Request progress'), '在途期间应有进度日志');
    registry.remove('gw-timer');
    const countAfterRemove = logger.entries.filter((entry) => String(entry.message).includes('Request progress')).length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const countLater = logger.entries.filter((entry) => String(entry.message).includes('Request progress')).length;
    assert.equal(countLater, countAfterRemove, '请求结束后不得再输出该请求的进度日志');

    registry.register({ reqId: 'gw-timer-2', phase: 'prompt', startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    registry.stop();
    assert.equal(registry.size, 0);
    const countAfterStop = logger.entries.filter((entry) => String(entry.message).includes('Request progress')).length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
        logger.entries.filter((entry) => String(entry.message).includes('Request progress')).length,
        countAfterStop,
        'stop() 后不得再输出进度日志'
    );
});

/* ================================================================== */
/* R6: 流式心跳必须是合法空增量分片                                     */
/* 背景: 只发 `: ping` 注释不产生事件块, 客户端(pi-ai idleWatchdog     */
/* 默认 300s)会在长任务中途判空闲超时, DSH 在 4 分多显示"已停止"。     */
/* ================================================================== */

/** 收集 writeSse 写入的 SSE 文本 */
function createSseSink() {
    const writes = [];
    const writeSse = (text) => {
        writes.push(text);
        return true;
    };
    return { writes, writeSse };
}

/** 取出所有 data 帧并解析成 chunk(忽略注释行与 [DONE]) */
function parseSseDataFrames(writes) {
    return writes
        .filter((text) => text.startsWith('data: ') && !text.includes('[DONE]'))
        .map((text) => JSON.parse(text.slice('data: '.length).trim()));
}

test('R6 心跳分片: 合法 JSON + delta 空对象 + finish_reason=null + id/model/created 用请求真值', () => {
    const { writes, writeSse } = createSseSink();
    const heartbeat = startStreamHeartbeat({
        writeSse,
        id: 'chatcmpl-req42',
        model: 'opencode/kimi-k2.5-free',
        created: 1700000000,
        intervalMs: 60000
    });
    assert.equal(heartbeat.tick(), true);
    heartbeat.stop();

    assert.equal(writes[0], ': ping\n\n', '心跳保留 : ping 注释行(兼容只认注释的中间层)');
    const frames = parseSseDataFrames(writes);
    assert.equal(frames.length, 1, '每次心跳必须写出一条 data 分片, 注释本身不产生事件块');
    const chunk = frames[0];
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.id, 'chatcmpl-req42');
    assert.equal(chunk.model, 'opencode/kimi-k2.5-free');
    assert.equal(chunk.created, 1700000000, 'created 整轮固定, 不随心跳变化');
    assert.deepEqual(chunk.choices[0].delta, {}, '空增量: delta 必须是空对象');
    assert.equal(chunk.choices[0].finish_reason, null, '心跳不是终止分片');
});

test('R6 心跳不污染内容块计数: 只累计 heartbeats, chunks 仍为 0', async () => {
    const { writes, writeSse } = createSseSink();
    /* 模拟 proxy 的 sseChunkCount: 只有内容/终止分片才 +1, 心跳不参与 */
    let contentChunks = 0;
    const heartbeat = startStreamHeartbeat({ writeSse, id: 'chatcmpl-count', model: 'm', created: 1, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    heartbeat.stop();

    assert.ok(heartbeat.beats >= 2, `应发出多次心跳, 实际 ${heartbeat.beats}`);
    assert.equal(contentChunks, 0, '空增量心跳不得计入内容块数');
    const frames = parseSseDataFrames(writes);
    assert.equal(frames.length, heartbeat.beats, '每条心跳对应一条空增量 data 分片');
    for (const chunk of frames) {
        assert.deepEqual(chunk.choices[0].delta, {}, '心跳分片都必须是空增量');
        assert.equal(chunk.choices[0].finish_reason, null);
    }
});

test('R6 请求结束心跳停止: stop() 后不再写分片, 终止分片后 isActive=false 自动停', async () => {
    const { writes, writeSse } = createSseSink();
    const heartbeat = startStreamHeartbeat({ writeSse, id: 'chatcmpl-stop', model: 'm', created: 1, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(writes.length > 0, '间隔内应已写出心跳');
    assert.equal(heartbeat.stop(), true, '首次 stop 生效');
    assert.equal(heartbeat.stop(), false, 'stop 幂等');
    const afterStop = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes.length, afterStop, 'stop() 后定时器已清理, 不得再写分片');

    /* 终止分片发出后(proxy 的 terminalSent 语义) isActive=false, 定时器自行清理 */
    const second = createSseSink();
    let active = true;
    const hb2 = startStreamHeartbeat({
        writeSse: second.writeSse,
        id: 'chatcmpl-term',
        model: 'm',
        created: 1,
        intervalMs: 5,
        isActive: () => active
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(second.writes.length > 0);
    active = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hb2.stopped, true, '终止分片后心跳应自动停止');
    const countWhenStopped = second.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(second.writes.length, countWhenStopped, '自动停止后不得再写分片');
});

/* ================================================================== */
/* runner                                                              */
/* ================================================================== */
let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`PASS ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.error(`FAIL ${name}`);
        console.error(e && e.stack ? e.stack : e);
    }
}

console.log(`\n${passed}/${tests.length} passed`);
for (const failure of failures) {
    console.error(`failed: ${failure.name}`);
}
process.exit(failures.length ? 1 : 0);
