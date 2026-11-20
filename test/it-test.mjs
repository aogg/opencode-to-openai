/**
 * 集成测试(mock opencode 事件流): collectSessionEvents 的消息角色过滤
 *
 * 复现的线上 bug: opencode 对 user message 的 text part 也发 message.part.updated,
 * 网关未判断所属 message 的 role, 把 dsh 注入的 "# 角色注入 / 系统提示词"(role=user)
 * 当成 assistant 首包 delta 回显, 客户端看到"先发系统提示词回来"。
 *
 * 断言: 只有 assistant 消息的 text/reasoning part 能进入 content/reasoning/
 * onDelta/firstDelta/deltaChars; user part 与来源不明的 part 一律不进入。
 *
 * 运行: node test/it-test.mjs (无外部依赖, 不启动 opencode)
 */

import assert from 'node:assert/strict';
import { collectSessionEvents } from '../src/opencode-events.js';

const SESSION_ID = 'ses_it_test';

/** 静默 logger, 同时收集 debug 日志用于断言 */
function createTestLogger() {
    const entries = [];
    const push = (level) => (message, detail) => entries.push({ level, message, detail });
    return {
        entries,
        error: push('error'),
        warn: push('warn'),
        info: push('info'),
        debug: push('debug')
    };
}

/**
 * 构造假 SDK client
 * @param {{events: object[], messages?: object[], lookupError?: Error|null, holdStream?: boolean}} opts
 */
function createFakeClient({ events, messages = [], lookupError = null }) {
    const calls = { messages: 0, subscribe: 0 };
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
                if (lookupError) throw lookupError;
                return { data: messages };
            }
        }
    };
    return { client, calls };
}

/** 跑一次 collector, 返回结果 + onDelta 收集到的增量 */
async function runCollector({ events, messages, lookupError, firstDeltaTimeoutMs = 0, idleTimeoutMs = 0 }) {
    const { client, calls } = createFakeClient({ events, messages, lookupError });
    const logger = createTestLogger();
    const deltas = [];
    const collector = collectSessionEvents({
        client,
        sessionId: SESSION_ID,
        reqId: 'it-test',
        timeoutMs: 5000,
        firstDeltaTimeoutMs,
        idleTimeoutMs,
        autoApprovePermission: false,
        onDelta: (delta, isReasoning) => deltas.push({ delta, isReasoning }),
        logger
    });
    const ready = await collector.ready;
    assert.equal(ready, true, '事件流订阅应成功');
    const result = await collector.promise;
    return { result, deltas, calls, logger };
}

function partEvent(part, properties = {}) {
    return { type: 'message.part.updated', properties: { part, ...properties } };
}

function textPart({ id = 'prt_1', messageID, text, sessionID = SESSION_ID, type = 'text' }) {
    return { id, sessionID, messageID, type, text };
}

function messageUpdated(info) {
    return { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, ...info } } };
}

const userInfo = (id = 'msg_user') => ({ id, sessionID: SESSION_ID, role: 'user' });
const assistantInfo = (id = 'msg_asst', extra = {}) => ({ id, sessionID: SESSION_ID, role: 'assistant', ...extra });

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

/* ------------------------------------------------------------------ */
/* 1. 核心复现: user part 先到(通过 session.messages 回填角色), 不得成为 delta */
test('user text part 不得进入 SSE delta(角色回填路径)', async () => {
    const { result, deltas, calls } = await runCollector({
        messages: [
            { info: userInfo(), parts: [] },
            { info: assistantInfo(), parts: [] }
        ],
        events: [
            partEvent(textPart({ id: 'prt_u1', messageID: 'msg_user', text: 'USER: 用一句话介绍你自己' })),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '我是 OpenCode 网关里的助手。' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.deepEqual(
        deltas,
        [{ delta: '我是 OpenCode 网关里的助手。', isReasoning: false }],
        '首个 delta 必须来自 assistant 消息'
    );
    assert.equal(result.content, '我是 OpenCode 网关里的助手。');
    assert.equal(result.receivedDelta, true);
    assert.equal(result.deltaChars, '我是 OpenCode 网关里的助手。'.length);
    assert.equal(calls.messages, 1, '未知 messageID 应只查询一次会话消息');
    assert.ok(!deltas.some((d) => d.delta.includes('用一句话介绍你自己')), 'user 文本不得回显');
});

/* ------------------------------------------------------------------ */
/* 2. message.updated 已缓存角色时不应再查 session.messages */
test('message.updated 缓存角色后不再额外查询', async () => {
    const { result, deltas, calls } = await runCollector({
        events: [
            messageUpdated(userInfo('msg_user')),
            partEvent(textPart({ id: 'prt_u1', messageID: 'msg_user', text: 'USER: 系统提示词注入内容' })),
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '正常回答' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(calls.messages, 0, '角色已知时不得发起 session.messages 查询');
    assert.deepEqual(deltas, [{ delta: '正常回答', isReasoning: false }]);
    assert.equal(result.content, '正常回答');
});

/* ------------------------------------------------------------------ */
/* 3. dsh 注入内容(以 "# 角色注入（dsh-rules-auto 插件" 开头) 不得进入 SSE */
test('dsh 角色注入(user 消息) 内容不得出现在 delta 中', async () => {
    const injected = '# 角色注入（dsh-rules-auto 插件，角色=code-js）\n# 项目系统提示词\n# 必看 - [./common-*/SKILL.md]';
    const { result, deltas, calls } = await runCollector({
        messages: [{ info: userInfo('msg_user'), parts: [] }, { info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            partEvent(textPart({ id: 'prt_u1', messageID: 'msg_user', text: `USER: ${injected}` })),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '已收到你的问题。' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(deltas.length, 1, '只应有一个 assistant 增量');
    const allText = deltas.map((d) => d.delta).join('');
    assert.equal(allText.includes('角色注入'), false, '角色注入内容不得进入 SSE');
    assert.equal(allText.includes('项目系统提示词'), false, '项目系统提示词不得进入 SSE');
    assert.equal(result.content, '已收到你的问题。');
    assert.equal(calls.messages, 1);
});

/* ------------------------------------------------------------------ */
/* 4. user 的 reasoning part 同样不得进入 reasoning/onDelta */
test('user reasoning part 不得进入 reasoning 增量', async () => {
    const { result, deltas } = await runCollector({
        messages: [{ info: userInfo('msg_user'), parts: [] }, { info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            partEvent(textPart({ id: 'prt_u1', messageID: 'msg_user', text: '用户推理注入', type: 'reasoning' })),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '助手推理', type: 'reasoning' })),
            partEvent(textPart({ id: 'prt_a2', messageID: 'msg_asst', text: '最终回答' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(result.reasoning, '助手推理');
    assert.deepEqual(deltas, [
        { delta: '助手推理', isReasoning: true },
        { delta: '最终回答', isReasoning: false }
    ]);
    assert.equal(result.content, '最终回答');
    assert.equal(result.reasoning.includes('用户推理注入'), false);
});

/* ------------------------------------------------------------------ */
/* 5. 角色查询失败: 保守跳过, 不回显, 且同一 messageID 只查一次 */
test('角色查询失败时保守跳过且每 messageID 只查一次', async () => {
    const { result, deltas, calls, logger } = await runCollector({
        lookupError: new Error('session.messages unreachable'),
        events: [
            partEvent(textPart({ id: 'prt_u1', messageID: 'msg_user', text: 'USER: 第一次' })),
            partEvent(textPart({ id: 'prt_u2', messageID: 'msg_user', text: 'USER: 第二次' })),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '来源不明的文本' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.deepEqual(deltas, [], '角色未知/查询失败时不得输出任何 delta');
    assert.equal(result.content, '');
    assert.equal(result.reasoning, '');
    assert.equal(result.deltaChars, 0);
    assert.equal(result.receivedDelta, false);
    assert.equal(calls.messages, 2, '每个未知 messageID 只查一次(msg_user/msg_asst)');
    assert.ok(
        logger.entries.some((e) => e.level === 'debug' && String(e.message).includes('role lookup failed')),
        '查询失败必须有 debug 日志'
    );
    assert.ok(
        logger.entries.some((e) => e.level === 'debug' && String(e.message).includes('skip non-assistant text part')),
        '跳过 part 必须有 debug 日志'
    );
});

/* ------------------------------------------------------------------ */
/* 6. 查询成功但消息列表里没有该 messageID: 仍保守跳过(不是 assistant) */
test('查不到对应消息时保守跳过', async () => {
    const { result, deltas, calls } = await runCollector({
        messages: [{ info: userInfo('msg_user'), parts: [] }],
        events: [
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_unknown', text: '未知来源文本' }))
        ]
    });

    assert.deepEqual(deltas, []);
    assert.equal(result.content, '');
    assert.equal(calls.messages, 1);
});

/* ------------------------------------------------------------------ */
/* 7. user message.updated(带 finish) 不得提前结束事件收集 */
test('user message.updated 不触发结束, 后续 assistant 文本仍能收到', async () => {
    const { result, deltas } = await runCollector({
        events: [
            messageUpdated(userInfo('msg_user')),
            messageUpdated({ ...userInfo('msg_user'), finish: 'stop' }),
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: 'assistant 正文' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(result.reason, 'message-finished');
    assert.equal(result.content, 'assistant 正文');
    assert.deepEqual(deltas, [{ delta: 'assistant 正文', isReasoning: false }]);
});

/* ------------------------------------------------------------------ */
/* 8. 无 delta 字段时按 part.text 差量化: 跨 part 只把增量给 assistant */
test('差量化仍正常: assistant 多 part 无 delta 字段', async () => {
    const { result, deltas } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            messageUpdated(assistantInfo('msg_asst')),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '你好' })),
            partEvent(textPart({ id: 'prt_a2', messageID: 'msg_asst', text: '你好，世界' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.deepEqual(deltas, [
        { delta: '你好', isReasoning: false },
        { delta: '，世界', isReasoning: false }
    ]);
    assert.equal(result.content, '你好，世界');
    assert.equal(result.deltaChars, '你好，世界'.length);
});

/* ------------------------------------------------------------------ */
/* 9. part 无 sessionID 时走 event.properties.sessionID 兜底(既有行为) */
test('part 缺少 sessionID 时用 properties.sessionID 兜底', async () => {
    const injectedPart = { id: 'prt_u1', messageID: 'msg_user', type: 'text', text: 'USER: 注入内容' };
    const answerPart = { id: 'prt_a1', messageID: 'msg_asst', type: 'text', text: '回答' };
    const { result, deltas } = await runCollector({
        messages: [{ info: userInfo('msg_user'), parts: [] }, { info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            { type: 'message.part.updated', properties: { sessionID: SESSION_ID, part: injectedPart } },
            { type: 'message.part.updated', properties: { sessionID: SESSION_ID, part: answerPart } },
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(result.content, '回答');
    assert.deepEqual(deltas, [{ delta: '回答', isReasoning: false }]);
});

/* ------------------------------------------------------------------ */
/* 10. tool part 只做日志, 不影响正文; assistant 文本照常 */
test('tool part 不污染正文且 user 文本不进入 tool 日志之外的内容', async () => {
    const { result, deltas } = await runCollector({
        messages: [{ info: assistantInfo('msg_asst'), parts: [] }],
        events: [
            messageUpdated(assistantInfo('msg_asst')),
            partEvent({
                id: 'prt_t1',
                sessionID: SESSION_ID,
                messageID: 'msg_asst',
                type: 'tool',
                tool: 'bash',
                callID: 'call_1',
                state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi' }
            }),
            partEvent(textPart({ id: 'prt_a1', messageID: 'msg_asst', text: '工具执行完成' })),
            messageUpdated(assistantInfo('msg_asst', { finish: 'stop' }))
        ]
    });

    assert.equal(result.content, '工具执行完成');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'bash');
    assert.deepEqual(deltas, [{ delta: '工具执行完成', isReasoning: false }]);
});

/* ------------------------------------------------------------------ */
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
