/**
 * 流式 SSE 心跳(空增量分片)
 *
 * 背景: 网关改造成 promptAsync + 轮询等待之后, 长任务在助手完成前不会再有任何内容增量,
 * 旧实现只发 `: ping` 注释。注释行对 SSE 解析器来说是"空操作", 不产生任何事件块, 所以
 * 按"每次从迭代器取到块就重置 idle 计时"实现的客户端(如 DSH 侧 pi-ai 的 idleWatchdog,
 * 默认 streamIdleTimeoutMs=300000)会把连接判成空闲超时, 在 T0+约 255 秒就显示"已停止",
 * 用户看不到 360 秒长任务的结果。
 *
 * 修复: 心跳改成合法的 OpenAI 空增量分片(choices[0].delta 为空对象, finish_reason=null),
 * 客户端能解析出事件并重置空闲计时; `: ping` 注释保留在分片前一行(兼容只认注释的老中间层)。
 *
 * 约束:
 * - 分片 id/model 用当前请求的真实值, created 用本轮启动时间戳(整轮固定, 不随心跳变化);
 * - 空增量心跳不计入内容块数(chunks), 只单独累计 heartbeats, 避免日志统计被污染;
 * - 只在"流式 + 还没发出终止分片 + 响应未结束"时发; 请求结束/断开都要 stop() 清定时器。
 */

/** 默认心跳间隔(毫秒), 与 proxy 的 SSE_HEARTBEAT_MS 默认值一致 */
export const DEFAULT_SSE_HEARTBEAT_MS = 15000;

/**
 * 构造合法的 OpenAI 空增量分片(不携带任何内容)
 * @param {{id: string, model: string, created: number}} params
 * @returns {{id: string, object: string, created: number, model: string, choices: Array<object>}}
 */
export function buildEmptyDeltaChunk({ id, model, created }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }]
    };
}

/**
 * 把分片格式化成一条 SSE data 帧
 * @param {object} chunk
 * @returns {string}
 */
export function formatSseChunk(chunk) {
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 启动流式心跳
 * @param {object} params
 * @param {(text: string) => boolean} params.writeSse 写 SSE 文本; 返回 false 表示已不可写(连接结束)
 * @param {string} params.id 本轮 chatcmpl id
 * @param {string} params.model 本轮模型标签
 * @param {number} params.created 本轮启动时间戳(秒), 整轮固定
 * @param {number} [params.intervalMs] 心跳间隔, 默认 DEFAULT_SSE_HEARTBEAT_MS
 * @param {() => boolean} [params.isActive] 是否还该发心跳(终止分片已发/响应已结束/断开时为 false)
 * @returns {{stop: () => boolean, tick: () => boolean, beats: number, stopped: boolean, intervalMs: number}}
 */
export function startStreamHeartbeat({
    writeSse,
    id,
    model,
    created,
    intervalMs = DEFAULT_SSE_HEARTBEAT_MS,
    isActive = () => true
}) {
    let stopped = false;
    let beats = 0;
    let timer = null;

    /** 停心跳(幂等); 返回本次是否真的停掉 */
    const stop = () => {
        if (stopped) return false;
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        return true;
    };

    /** 发一次心跳: `: ping` 注释 + 一条合法空增量 data 分片 */
    const tick = () => {
        if (stopped) return false;
        if (!isActive()) {
            stop();
            return false;
        }
        writeSse(': ping\n\n');
        const chunk = buildEmptyDeltaChunk({ id, model, created });
        /* 只有真的写出去才计数; 空增量不属于内容块, 由 beats 单独统计 */
        if (writeSse(formatSseChunk(chunk))) beats += 1;
        return true;
    };

    /* 间隔非法(0/负数/NaN)时不启动定时器, 返回一个可安全 stop 的空心跳 */
    const validInterval = Number.isFinite(intervalMs) && intervalMs > 0;
    if (validInterval) {
        timer = setInterval(tick, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    return {
        stop,
        tick,
        get beats() {
            return beats;
        },
        get stopped() {
            return stopped;
        },
        intervalMs: validInterval ? intervalMs : 0
    };
}
