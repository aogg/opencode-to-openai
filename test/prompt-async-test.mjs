/**
 * promptAsync 长任务回归测试
 *
 * 背景: session.prompt 会一直占着一条 HTTP 连接等模型跑完, Node 内置 fetch(undici)默认
 * 300 秒 bodyTimeout 会把长任务(sleep 360)在 300.6 秒掐断("fetch failed"), 与网关的
 * REQUEST_TIMEOUT_MS(默认 30 分钟)无关。
 *
 * 覆盖点:
 * 1) promptAsync 只提交一次、参数与 session.prompt 一致, 且绝不回退到 session.prompt;
 * 2) 提交后轮询必须等到 assistant 本轮终态才返回内容(tool-calls 中间步骤不算完成);
 * 3) 6 分钟长任务在 30 分钟预算内正常完成, 不会被 300 秒截断;
 * 4) promptAsync 返回 error / 抛错时走原有错误路径;
 * 5) 快速失败(429)在提交与轮询两个阶段都仍然立即生效;
 * 6) SSE 空闲超时提前结束时, 轮询能拿到最终内容(不返回空结果);
 * 7) collector 终态判定: 中间 step(tool-calls)不结束收集, 终态 finish 才结束; session.error 立即结束。
 *
 * 运行: node test/prompt-async-test.mjs (纯 Node, 无外部依赖, 不启动 opencode)
 */

import assert from 'node:assert/strict';
import {
    DEFAULT_POLL_INTERVAL_MS,
    isAssistantMessageDone,
    pollForAssistantResponse,
    submitPromptAsync
} from '../src/prompt-async.js';
import { collectSessionEvents, isTerminalAssistantFinish } from '../src/opencode-events.js';
import { UpstreamRetryError } from '../src/retry-guard.js';

const SESSION_ID = 'ses_prompt_async_test';
const REQUEST_TIMEOUT_MS = 1800000;

const PROMPT_PARAMS = {
    path: { id: SESSION_ID },
    body: {
        model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' },
        system: 'system prompt',
        parts: [{ type: 'text', text: '执行 sleep 360 再回复' }]
    }
};

/** 静默 logger, 同时收集日志用于断言 */
function createTestLogger() {
    const entries = [];
    const push = (level) => (message, detail) => entries.push({ level, message, detail });
    return {
        entries,
        error: push('error'),
        warn: push('warn'),
        info: push('info'),
        debug: push('debug'),
        find(level, keyword) {
            return entries.find((entry) => entry.level === level && String(entry.message).includes(keyword));
        }
    };
}

/** 假时钟: 让"6 分钟长任务"在毫秒内跑完, 同时保持真实的时间顺序语义 */
function createClock() {
    let current = 0;
    return {
        now: () => current,
        wait: async (ms) => { current += ms; },
        advance: (ms) => { current += ms; },
        get current() {
            return current;
        }
    };
}

function assistantEntry(info, text) {
    return { info: { sessionID: SESSION_ID, role: 'assistant', ...info }, parts: [{ type: 'text', text }] };
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

/* ================================================================== */
/* 1) 提交: promptAsync 只调用一次, 参数一致, 不回退                     */
/* ================================================================== */

test('提交: promptAsync 只调用一次, path/body 与 session.prompt 相同, 绝不调用 session.prompt', async () => {
    const calls = { promptAsync: 0, prompt: 0 };
    const seen = [];
    const client = {
        session: {
            promptAsync: async (params) => {
                calls.promptAsync += 1;
                seen.push(params);
                /* 服务端 prompt_async 返回 204(无 body) */
                return { data: undefined, response: { status: 204 } };
            },
            prompt: async () => {
                calls.prompt += 1;
                throw new Error('session.prompt 不得再被调用: 它会占用长连接并在 300s 被 fetch 超时掐断');
            }
        }
    };
    const logger = createTestLogger();
    const result = await submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: 5000, reqId: 'gw-test', logger });
    assert.equal(calls.promptAsync, 1, 'promptAsync 必须只提交一次');
    assert.equal(calls.prompt, 0, '不得回退到 session.prompt');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], PROMPT_PARAMS, '提交参数必须与 session.prompt 完全一致(path.id + body)');
    assert.ok(result, 'promptAsync 结果必须透传');
    assert.ok(logger.find('debug', 'promptAsync accepted'), '应有受理日志');
});

test('提交: SDK 不支持 promptAsync 时明确报错, 不回退到 session.prompt', async () => {
    const client = { session: { prompt: async () => ({ data: {} }) } };
    await assert.rejects(
        () => submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: 1000 }),
        /does not support session\.promptAsync/
    );
});

/* ================================================================== */
/* 2) 轮询: 必须等到 assistant 本轮终态                                 */
/* ================================================================== */

test('轮询: 中间步骤(tool-calls)不返回, 只在终态(stop)返回最终内容', async () => {
    const userEntry = { info: { id: 'msg_user', sessionID: SESSION_ID, role: 'user' }, parts: [{ type: 'text', text: 'go' }] };
    const pollResponses = [
        /* 刚提交: 只有 user 消息 */
        { data: [userEntry] },
        /* 第一个 step: 有内容但 finish=tool-calls(工具还在跑) */
        { data: [userEntry, assistantEntry({ id: 'msg_a1', finish: 'tool-calls', time: { created: 1, completed: 2 } }, '先去跑 sleep 360')] },
        /* 新开了 assistant 消息但还没结束: 没有 finish */
        { data: [userEntry, assistantEntry({ id: 'msg_a1', finish: 'tool-calls', time: { created: 1, completed: 2 } }, '先去跑 sleep 360'), assistantEntry({ id: 'msg_a2', time: { created: 3 } }, '等待中')] },
        /* 本轮终态 */
        { data: [userEntry, assistantEntry({ id: 'msg_a1', finish: 'tool-calls', time: { created: 1, completed: 2 } }, '先去跑 sleep 360'), assistantEntry({ id: 'msg_a2', finish: 'stop', time: { created: 3, completed: 9 } }, '最终答案')] }
    ];
    let polls = 0;
    const client = {
        session: {
            messages: async () => {
                const response = pollResponses[Math.min(polls, pollResponses.length - 1)];
                polls += 1;
                return response;
            }
        }
    };
    const logger = createTestLogger();
    const result = await pollForAssistantResponse({
        client,
        sessionId: SESSION_ID,
        timeoutMs: 5000,
        intervalMs: 1,
        requireDone: true,
        reqId: 'gw-test',
        logger
    });
    assert.equal(result.content, '最终答案', '只能返回本轮终态的消息内容');
    assert.equal(result.done, true);
    assert.ok(polls >= 4, `必须轮询到终态才返回, 实际轮询 ${polls} 次`);
    assert.ok(logger.find('debug', 'not finished yet'), '未完成时应记录等待日志');
    assert.ok(logger.find('debug', 'Polling completed'), '完成时应有轮询完成日志');
});

test('轮询: requireDone 只看最后一条, 不能被更早的已完成消息提前满足', async () => {
    let polls = 0;
    const client = {
        session: {
            messages: async () => {
                polls += 1;
                if (polls === 1) {
                    return {
                        data: [
                            assistantEntry({ id: 'msg_old', finish: 'stop', time: { created: 1, completed: 2 } }, '旧一轮答案'),
                            assistantEntry({ id: 'msg_new', finish: 'tool-calls', time: { created: 3, completed: 4 } }, '新一轮还在跑')
                        ]
                    };
                }
                return {
                    data: [
                        assistantEntry({ id: 'msg_old', finish: 'stop', time: { created: 1, completed: 2 } }, '旧一轮答案'),
                        assistantEntry({ id: 'msg_new', finish: 'stop', time: { created: 3, completed: 8 } }, '新一轮答案')
                    ]
                };
            }
        }
    };
    const result = await pollForAssistantResponse({
        client,
        sessionId: SESSION_ID,
        timeoutMs: 5000,
        intervalMs: 1,
        requireDone: true
    });
    assert.equal(result.content, '新一轮答案');
    assert.ok(polls >= 2);
});

/* ================================================================== */
/* 3) 6 分钟长任务不被 300 秒截断                                       */
/* ================================================================== */

const SIX_MINUTES = 6 * 60 * 1000;
const UNDICI_DEFAULT_TIMEOUT_MS = 300000;

function createLongTaskClient(clock) {
    const calls = { promptAsync: 0, prompt: 0, messages: 0 };
    const client = {
        session: {
            promptAsync: async () => {
                calls.promptAsync += 1;
                return { data: undefined, response: { status: 204 } };
            },
            prompt: async () => {
                calls.prompt += 1;
                throw new Error('session.prompt 不得被调用');
            },
            messages: async () => {
                calls.messages += 1;
                /* 6 分钟前: 只看到 tool-calls 的中间 step(模拟 bash sleep 360) */
                if (clock.current < SIX_MINUTES) {
                    return {
                        data: [
                            assistantEntry(
                                { id: 'msg_step', finish: 'tool-calls', time: { created: 0, completed: clock.current } },
                                'sleep 360 正在运行'
                            )
                        ]
                    };
                }
                return {
                    data: [
                        assistantEntry(
                            { id: 'msg_final', finish: 'stop', time: { created: 0, completed: clock.current } },
                            '睡了 360 秒, 任务完成'
                        )
                    ]
                };
            }
        }
    };
    return { client, calls };
}

test('长任务: 6 分钟(360s)在 30 分钟预算内完成, 不会被 300 秒截断', async () => {
    const clock = createClock();
    const { client, calls } = createLongTaskClient(clock);
    const logger = createTestLogger();

    /* 1) 提交: 必须"立即"返回, 不消耗模拟时间(短连接) */
    await submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: REQUEST_TIMEOUT_MS, reqId: 'gw-long', logger });
    assert.equal(calls.promptAsync, 1);
    assert.equal(calls.prompt, 0, '长任务路径不得再调用 session.prompt');
    assert.equal(clock.current, 0, '提交阶段不能占用等待时间');

    /* 2) 等待完成: 用假时钟模拟 6 分钟, 期间 poll 只看到中间步骤 */
    const result = await pollForAssistantResponse({
        client,
        sessionId: SESSION_ID,
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        requireDone: true,
        reqId: 'gw-long',
        logger,
        now: clock.now,
        wait: clock.wait
    });
    assert.equal(result.content, '睡了 360 秒, 任务完成');
    assert.ok(clock.current >= SIX_MINUTES, `必须等到 6 分钟任务结束, 实际模拟 ${clock.current}ms`);
    assert.ok(clock.current < REQUEST_TIMEOUT_MS, '完成时间必须小于 30 分钟总预算');
    assert.ok(clock.current > UNDICI_DEFAULT_TIMEOUT_MS, '任务时长超过 undici 默认 300s: 这条路径必须能扛过去');
    assert.equal(calls.prompt, 0);
    assert.ok(calls.messages > 0, '等待期间必须真的轮询了 session.messages');
});

test('长任务: 对照用例, 300 秒预算下会明确报 Request timeout(旧实现被掐断的时间点)', async () => {
    const clock = createClock();
    const { client } = createLongTaskClient(clock);
    await assert.rejects(
        () => pollForAssistantResponse({
            client,
            sessionId: SESSION_ID,
            timeoutMs: UNDICI_DEFAULT_TIMEOUT_MS,
            intervalMs: DEFAULT_POLL_INTERVAL_MS,
            requireDone: true,
            now: clock.now,
            wait: clock.wait
        }),
        /Request timeout after 300000ms/
    );
});

/* ================================================================== */
/* 4) 提交错误路径                                                      */
/* ================================================================== */

test('提交错误: promptAsync 返回 error 时抛 Send prompt failed(带 status), 走原有错误路径', async () => {
    const client = {
        session: {
            promptAsync: async () => ({
                error: { message: 'Model not found: opencode/not-exist' },
                response: { status: 400 }
            })
        }
    };
    await assert.rejects(
        () => submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: 5000 }),
        (error) => {
            assert.ok(error.message.includes('Send prompt failed'), `错误信息应带 Send prompt failed, 实际: ${error.message}`);
            assert.ok(error.message.includes('Model not found'));
            assert.equal(error.status, 400);
            return true;
        }
    );
});

test('提交错误: promptAsync 直接抛错(网络/undici)时原样抛出', async () => {
    const client = {
        session: {
            promptAsync: async () => {
                throw new TypeError('fetch failed');
            }
        }
    };
    await assert.rejects(
        () => submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: 5000 }),
        /fetch failed/
    );
});

/* ================================================================== */
/* 5) 快速失败仍然生效                                                  */
/* ================================================================== */

test('快速失败: 提交阶段收到 retry 信号立即抛 UpstreamRetryError, 不等超时', async () => {
    let resolveFastFail = null;
    const fastFailPromise = new Promise((resolve) => { resolveFastFail = resolve; });
    const client = { session: { promptAsync: () => new Promise(() => {}) } };
    const startedAt = Date.now();
    const pending = submitPromptAsync(client, PROMPT_PARAMS, { timeoutMs: 300000, fastFailPromise });
    setTimeout(() => resolveFastFail({ message: 'Free usage exceeded', nextInMs: 51401998, retryAfterMs: 51401998 }), 10);
    await assert.rejects(
        () => pending,
        (error) => {
            assert.ok(error instanceof UpstreamRetryError);
            assert.equal(error.info.nextInMs, 51401998);
            return true;
        }
    );
    assert.ok(Date.now() - startedAt < 2000, '必须立即失败, 不能被超时定时器拖住');
});

test('快速失败: 轮询阶段收到 retry 信号立即抛 UpstreamRetryError, 不再查消息', async () => {
    let messageCalls = 0;
    const client = {
        session: {
            messages: async () => {
                messageCalls += 1;
                return { data: [] };
            }
        }
    };
    await assert.rejects(
        () => pollForAssistantResponse({
            client,
            sessionId: SESSION_ID,
            timeoutMs: 5000,
            intervalMs: 1,
            requireDone: true,
            getFastFail: () => ({ message: 'Free usage exceeded', nextInMs: 51401998, reason: 'quota-message' })
        }),
        UpstreamRetryError
    );
    assert.equal(messageCalls, 0, '快速失败必须在查询消息前生效');
});

/* ================================================================== */
/* 6) 终态判定                                                          */
/* ================================================================== */

test('终态判定: error / stop / length 完成; tool-calls / unknown / 无 finish 未完成', () => {
    assert.equal(isTerminalAssistantFinish('stop'), true);
    assert.equal(isTerminalAssistantFinish('length'), true);
    assert.equal(isTerminalAssistantFinish('error'), true);
    assert.equal(isTerminalAssistantFinish('tool-calls'), false);
    assert.equal(isTerminalAssistantFinish('unknown'), false);
    assert.equal(isTerminalAssistantFinish(''), false);
    assert.equal(isTerminalAssistantFinish(null), false);

    assert.equal(isAssistantMessageDone({ finish: 'stop' }), true);
    assert.equal(isAssistantMessageDone({ finish: 'length' }), true);
    assert.equal(isAssistantMessageDone({ error: { name: 'APIError' } }), true, '带 error 的消息也是终态');
    assert.equal(isAssistantMessageDone({ finish: 'tool-calls' }), false, 'tool-calls 只是中间步骤');
    assert.equal(isAssistantMessageDone({ finish: 'unknown' }), false);
    assert.equal(isAssistantMessageDone({ time: { created: 1 } }), false);
    assert.equal(isAssistantMessageDone(null), false);
});

/* ================================================================== */
/* 7) SSE 空闲超时 + 轮询兜底                                            */
/* ================================================================== */

/** 事件流先发 initialEvents 再一直静默(不结束), 用于触发 idleTimeout */
function createSilentEventClient(initialEvents = []) {
    const calls = { subscribe: 0, abort: 0 };
    const client = {
        event: {
            subscribe: async () => {
                calls.subscribe += 1;
                return {
                    stream: {
                        [Symbol.asyncIterator]() {
                            let index = 0;
                            return {
                                next: () => {
                                    if (index < initialEvents.length) {
                                        const value = initialEvents[index];
                                        index += 1;
                                        return Promise.resolve({ value, done: false });
                                    }
                                    /* 静默: 永不产生下一个事件(模拟长时间没有 SSE 事件) */
                                    return new Promise(() => {});
                                }
                            };
                        }
                    }
                };
            }
        },
        session: {
            messages: async () => ({ data: [] }),
            abort: async () => {
                calls.abort += 1;
                return { data: true };
            }
        }
    };
    return { client, calls };
}

test('SSE 空闲超时提前结束: 轮询必须拿到最终内容, 不能返回空结果', async () => {
    /* 先有一个工具活动事件(启动 idle 计时), 之后长时间无事件 → idleTimeout */
    const { client, calls } = createSilentEventClient([
        partEvent({
            id: 'prt_tool',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'sleep 360' }, time: { start: 0 } }
        })
    ]);
    const logger = createTestLogger();
    const collector = collectSessionEvents({
        client,
        sessionId: SESSION_ID,
        reqId: 'gw-idle',
        timeoutMs: 5000,
        firstDeltaTimeoutMs: 0,
        idleTimeoutMs: 20,
        autoApprovePermission: false,
        logger
    });
    assert.equal(await collector.ready, true);
    const collected = await collector.promise;
    assert.equal(collected.reason, 'idle-timeout', 'SSE 因长时间无事件提前结束');
    assert.equal(collected.content, '');

    /* 模拟 proxy 的兜底轮询: 拿假时钟把"任务跑完"推进到 6 分钟后 */
    const clock = createClock();
    const { client: longTaskClient, calls: longCalls } = createLongTaskClient(clock);
    const result = await pollForAssistantResponse({
        client: longTaskClient,
        sessionId: SESSION_ID,
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        requireDone: true,
        reqId: 'gw-idle',
        logger,
        sanitize: (text, channel) => `[${channel}]${text}`,
        now: clock.now,
        wait: clock.wait
    });
    assert.equal(result.content, '[content]睡了 360 秒, 任务完成', '轮询结果必须带回最终内容并经过输出裁剪回调');
    assert.equal(result.error, null);
    assert.equal(longCalls.promptAsync, 0, '兜底轮询只查消息, 不再提交');
    assert.equal(calls.abort, 0, '空闲超时不是 fastFail, 不应 abort 上游');
});

/* ================================================================== */
/* 8) collector 终态判定(SSE 完成信号)                                  */
/* ================================================================== */

/** 构造假 opencode SDK client(仅事件流 + messages + abort) */
function createEventClient(events) {
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
            messages: async () => {
                calls.messages += 1;
                return { data: [] };
            },
            abort: async () => {
                calls.abort += 1;
                return { data: true };
            }
        }
    };
    return { client, calls };
}

async function runCollector(events) {
    const { client, calls } = createEventClient(events);
    const logger = createTestLogger();
    const deltas = [];
    const collector = collectSessionEvents({
        client,
        sessionId: SESSION_ID,
        reqId: 'gw-collector',
        timeoutMs: 5000,
        firstDeltaTimeoutMs: 0,
        idleTimeoutMs: 0,
        autoApprovePermission: false,
        logger,
        onDelta: (delta, isReasoning) => deltas.push({ delta, isReasoning })
    });
    assert.equal(await collector.ready, true);
    return { result: await collector.promise, deltas, calls, logger };
}

const messageUpdated = (info) => ({
    type: 'message.updated',
    properties: { info: { sessionID: SESSION_ID, ...info } }
});
const partEvent = (part) => ({
    type: 'message.part.updated',
    properties: { part: { sessionID: SESSION_ID, messageID: 'msg_asst', ...part } }
});

test('collector: 中间 step finish=tool-calls 不结束收集, 终态 finish=stop 才结束', async () => {
    const { result, deltas } = await runCollector([
        messageUpdated({ id: 'msg_asst', role: 'assistant' }),
        partEvent({ id: 'prt_1', type: 'text', text: '第一步' }),
        messageUpdated({ id: 'msg_asst', role: 'assistant', finish: 'tool-calls', time: { created: 1, completed: 2 } }),
        partEvent({ id: 'prt_2', type: 'text', text: '第一步继续' }),
        messageUpdated({ id: 'msg_asst', role: 'assistant', finish: 'stop', time: { created: 1, completed: 9 } })
    ]);
    assert.equal(result.reason, 'message-finished');
    assert.equal(result.content, '第一步继续');
    assert.deepEqual(deltas, [
        { delta: '第一步', isReasoning: false },
        { delta: '继续', isReasoning: false }
    ]);
});

test('collector: assistant 消息带 error(没有 finish)时立即结束并透出错误', async () => {
    const { result } = await runCollector([
        messageUpdated({ id: 'msg_asst', role: 'assistant' }),
        messageUpdated({
            id: 'msg_asst',
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'provider auth failed' } },
            time: { created: 1, completed: 2 }
        })
    ]);
    assert.equal(result.reason, 'message-finished');
    assert.ok(result.error, '错误必须透出给 proxy 走 502/错误路径');
    assert.equal(result.error.name, 'APIError');
});

test('collector: session.error(模型不存在等提交期失败)立即结束, 不空等超时', async () => {
    const startedAt = Date.now();
    const { result } = await runCollector([
        {
            type: 'session.error',
            properties: {
                sessionID: SESSION_ID,
                error: { name: 'UnknownError', data: { message: 'Model not found: opencode/not-exist' } }
            }
        }
    ]);
    assert.equal(result.reason, 'session-error');
    assert.equal(result.sessionError, true);
    assert.equal(result.error.name, 'UnknownError');
    assert.equal(result.error.data.message.includes('Model not found'), true);
    assert.ok(Date.now() - startedAt < 2000, 'session.error 必须立即结束收集');
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
