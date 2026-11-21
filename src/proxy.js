import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { spawn } from 'child_process';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { logger, maskHeaders } from './logger.js';
import {
    buildPromptMessages,
    parseSystemPromptPatterns,
    previewText,
    summarizeUpstreamPayload
} from './prompt-builder.js';
import { collectSessionEvents } from './opencode-events.js';
import { buildEchoPatterns, sanitizeAssistantText } from './output-guard.js';
import {
    DEFAULT_FAST_FAIL_RETRY_MS,
    buildRetryFailure,
    isUpstreamRetryError
} from './retry-guard.js';
import {
    DEFAULT_POLL_INTERVAL_MS,
    pollForAssistantResponse,
    submitPromptAsync
} from './prompt-async.js';
import {
    DEFAULT_PROGRESS_LOG_INTERVAL_MS,
    DEFAULT_STALL_WARN_MS,
    createInflightRegistry
} from './inflight.js';
import {
    DEFAULT_QUEUE_MAX_WAIT_MS,
    buildQueueTimeoutResponse,
    createSerialQueue,
    isQueueTimeoutError
} from './serial-queue.js';
import { resolveOpencodeLogFile, startOpencodeLogTail } from './opencode-log-tail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
/* 30 分钟: 必须大于 PROGRESS_LOG_INTERVAL_MS / STALL_WARN_MS(默认都是 5 分钟),
 * 否则长任务(如 bash 里 sleep 320)会在 5 分钟被硬超时打断, 看门狗告警也永远来不及触发 */
const DEFAULT_REQUEST_TIMEOUT_MS = 1800000;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 4000;
/* 工具任务期间可能长时间没有文本增量, 空闲超时从 8s 放宽到 60s, 且工具活动会重置计时 */
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 60000;
/* 流式期间定期发 SSE 注释心跳(: ping), 避免客户端/中间层把长任务当空闲断开 */
const DEFAULT_SSE_HEARTBEAT_MS = 15000;
/*
 * 自动批准权限需要注入 opencode 配置的 permission 规则。
 * 注意: opencode 1.19.5 的 `opencode serve` 不支持 `--auto`(传了会打印 help 并 exit 1, 已实测),
 * 因此自动批准走"配置层 permission=allow" + "事件层 permission.updated 自动回复 once" 两层。
 */
const AUTO_APPROVE_PERMISSION_KEYS = ['edit', 'bash', 'webfetch', 'external_directory', 'doom_loop', 'read', 'glob', 'list', 'grep', 'task', 'question'];
const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

const OPENCODE_BASENAME = 'opencode';

function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
    }
    return [OPENCODE_BASENAME];
}

function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
        }
    }

    const pathDirs = splitPathEnv();
    const fromPath = findExecutableInDirs(pathDirs, names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(extraDirs, process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null);
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

/**
 * Robust Health Check Helper
 */
function checkHealth(serverUrl) {
    return new Promise((resolve, reject) => {
        const req = http.get(`${serverUrl}/health`, (res) => {
            if (res.statusCode === 200) resolve(true);
            else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Cleanup temporary directories
 */
function cleanupTempDirs() {
    // Only cleanup jail directories on non-Windows platforms
    // On Windows, we don't use isolated jail to avoid path issues
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        logger.error('[Cleanup] Failed to remove temp dirs:', { error: e.message });
    }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Handle signals - Unix-like systems
if (process.platform !== 'win32') {
    process.on('SIGINT', () => {
        logger.info('[Shutdown] Received SIGINT, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        logger.info('[Shutdown] Received SIGTERM, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
}
// Note: Windows signal handling is limited, cleanup is handled via process.on('exit')

/**
 * 从上游(opencode serve)调用错误中尽力提取状态码与错误体摘要
 * SDK 错误结构随版本可能不同, 兼容常见字段: response.{status,data} / status / statusCode / responseBody / data / body
 */
function extractUpstreamError(error) {
    const status = error?.response?.status ?? error?.status ?? error?.statusCode ?? null;
    const body = error?.response?.data ?? error?.responseBody ?? error?.data ?? error?.body ?? null;
    let bodySummary = null;
    if (typeof body === 'string') {
        bodySummary = body.slice(0, 500) || null;
    } else if (body !== null && body !== undefined) {
        try {
            bodySummary = JSON.stringify(body).slice(0, 500);
        } catch (e) {
            // 序列化失败不静默: 摘要中注明原因
            bodySummary = `[unserializable: ${e?.message || 'unknown error'}]`;
        }
    }
    return { status, bodySummary, retryAfter: extractRetryAfter(error, body) };
}

/**
 * 尽力提取上游限流的重试提示: 优先响应头 retry-after, 其次错误体里的 retry-after 文本
 */
function extractRetryAfter(error, body) {
    const headers = error?.response?.headers || error?.headers || null;
    if (headers) {
        const raw = headers['retry-after'] ?? headers['Retry-After'] ?? null;
        if (raw !== null && raw !== undefined && raw !== '') return String(raw).slice(0, 120);
    }
    const text = typeof body === 'string' ? body : (() => {
        try {
            return body === null || body === undefined ? '' : JSON.stringify(body);
        } catch (e) {
            // 序列化失败不静默: 用错误信息代替, 避免直接抛
            return `[unserializable: ${e.message}]`;
        }
    })();
    const match = String(text).match(/retry[-_ ]?after"?\s*[:=]?\s*"?(\d+(?:\.\d+)?\s*(?:ms|s|seconds|秒)?)/i);
    return match ? match[1].trim() : null;
}

/**
 * SDK 默认 throwOnError=false: 上游 4xx/5xx 会以 { error, response } 形式返回而不是抛异常。
 * 这里统一抛成 Error(带 status / responseBody), 让错误日志能带状态码与错误体摘要。
 * @param {object} result SDK 调用结果
 * @param {string} label 阶段描述
 */
function assertNoUpstreamError(result, label) {
    if (!result || !result.error) return result;
    let errorText;
    if (typeof result.error === 'string') {
        errorText = result.error;
    } else {
        try {
            errorText = JSON.stringify(result.error).slice(0, 300);
        } catch (e) {
            // 序列化失败不静默: 用错误信息代替
            errorText = `[unserializable error: ${e.message}]`;
        }
    }
    const error = new Error(`${label} failed: ${errorText}`);
    error.status = result.response?.status ?? null;
    error.responseBody = result.error;
    throw error;
}

/**
 * Create Express app with proper configuration
 * (导出便于本地冒烟测试: 用 stub 依赖直接调用路由处理函数, 不启动真实服务)
 */
export function createApp(config) {
    // DEBUG 不再直接控制输出(由 startProxy 统一映射为 debug 日志等级), 故不在此解构
    const {
        API_KEY,
        OPENCODE_SERVER_URL,
        REQUEST_TIMEOUT_MS,
        DISABLE_TOOLS,
        OPENCODE_WORKDIR,
        OPENCODE_AUTO_APPROVE,
        OPENCODE_STREAM_TOOLS,
        SYSTEM_PROMPT_PATTERNS,
        EVENT_IDLE_TIMEOUT_MS,
        SSE_HEARTBEAT_MS,
        FAST_FAIL_RETRY_MS,
        QUEUE_MAX_WAIT_MS,
        PROGRESS_LOG_INTERVAL_MS,
        STALL_WARN_MS
    } = config;

    const app = express();

    // 请求日志中间件(最先挂载, 覆盖全部请求含 401/404):
    // info 级输出每个 OpenAI 兼容请求(/v1/*)的一行摘要; 其余路径(/health 等)仅 debug 级, 避免健康检查刷屏
    app.use((req, res, next) => {
        const reqId = `gw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = Date.now();
        req.gatewayLog = { reqId };
        res.on('finish', () => {
            const meta = req.gatewayLog || {};
            const model = meta.model || '-';
            const streamText = typeof meta.stream === 'boolean' ? String(meta.stream) : '-';
            const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms [${reqId}] model=${model} stream=${streamText}`;
            const isOpenAiPath = req.path && req.path.startsWith('/v1/');
            if (isOpenAiPath) {
                logger.info(line);
            } else {
                logger.debug(line);
            }
        });
        next();
    });

    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
    app.use(bodyParser.json({ limit: '50mb' }));

    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL });

    /* 系统提示词提升规则: 命中规则的 user 消息内容提升到 prompt body.system, 不再拼进 parts */
    const promptPatterns = parseSystemPromptPatterns(SYSTEM_PROMPT_PATTERNS);
    if (promptPatterns.invalid.length) {
        logger.warn('[Proxy] Invalid SYSTEM_PROMPT_PATTERNS entries were ignored', { invalid: promptPatterns.invalid });
    }
    logger.info('[Proxy] System prompt patterns loaded', {
        mode: promptPatterns.disabled ? 'disabled' : (promptPatterns.configured ? 'custom' : 'default'),
        count: promptPatterns.patterns.length,
        patterns: promptPatterns.sources
    });

    /*
     * 输出侧兜底标记: 与系统提示词提升共用 SYSTEM_PROMPT_PATTERNS, 另加角色前缀等额外标记。
     * 上游把 user/system 内容当 assistant part 回显时, 响应里裁掉(流式按增量、非流式按整段)。
     */
    const echoPatterns = buildEchoPatterns(SYSTEM_PROMPT_PATTERNS);
    logger.info('[Proxy] Output echo guard loaded', {
        count: echoPatterns.length,
        markers: echoPatterns.map((item) => item.source)
    });

    /* 在途请求注册表: 每 PROGRESS_LOG_INTERVAL_MS 输出进度 + 卡住看门狗 + GET /v1/gateway/inflight 查询 */
    const inflight = createInflightRegistry({
        logger,
        progressIntervalMs: PROGRESS_LOG_INTERVAL_MS,
        stallWarnMs: STALL_WARN_MS
    });
    inflight.startWatchdog();

    /* 单并发队列(带排队上限): 上游卡住时后续请求不再无限排队, 超过 QUEUE_MAX_WAIT_MS 直接 503 */
    const serialQueue = createSerialQueue({
        logger,
        maxWaitMs: QUEUE_MAX_WAIT_MS,
        nextDelayMs: 100
    });

    // Auth middleware
    app.use((req, res, next) => {
        if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/') return next();
        if (API_KEY && API_KEY.trim() !== '') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
                return res.status(401).json({ error: { message: 'Unauthorized' } });
            }
        }
        next();
    });

    // Models endpoint
    app.get('/v1/models', async (req, res) => {
        try {
            const providersRes = await client.config.providers();
            const providersRaw = providersRes.data?.providers || [];
            const models = [];
            const list = Array.isArray(providersRaw)
                ? providersRaw
                : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

            list.forEach((p) => {
                if (p.models) {
                    Object.entries(p.models).forEach(([mId, mData]) => {
                        models.push({
                            id: `${p.id}/${mId}`,
                            name: mData.name || mId,
                            object: 'model',
                            owned_by: p.id
                        });
                    });
                }
            });
            res.json({ object: 'list', data: models });
        } catch (error) {
            logger.error('[Proxy] Model Fetch Error:', { error: error.message, status: error.status, body: error.response?.data || error.responseBody || null });
            res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
        }
    });

    // debug 日志统一走 logger(LOG_LEVEL=debug 时可见; 兼容旧 DEBUG 开关, startProxy 会把 DEBUG=true 映射为 debug 等级)
    const logDebug = (...args) => logger.debug(...args);

    const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const applyToolGuard = (systemMsg) => {
        if (!DISABLE_TOOLS) return systemMsg || undefined;
        if (systemMsg && systemMsg.trim()) {
            return `${systemMsg}\n\n${TOOL_GUARD_MESSAGE}`;
        }
        return TOOL_GUARD_MESSAGE;
    };

    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        const cleaned = text
            .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
            .replace(/<\/?function_calls>/g, '');
        return trim ? cleaned.trim() : cleaned;
    };

    const createToolCallFilter = () => {
        if (!DISABLE_TOOLS) return (chunk) => chunk;
        let inBlock = false;
        return (chunk) => {
            if (!chunk) return chunk;
            let output = '';
            let remaining = chunk;
            while (remaining.length) {
                if (inBlock) {
                    const endIdx = remaining.indexOf('</function_calls>');
                    if (endIdx === -1) {
                        return output;
                    }
                    remaining = remaining.slice(endIdx + '</function_calls>'.length);
                    inBlock = false;
                    continue;
                }
                const startIdx = remaining.indexOf('<function_calls>');
                if (startIdx === -1) {
                    output += remaining;
                    return output;
                }
                output += remaining.slice(0, startIdx);
                remaining = remaining.slice(startIdx + '<function_calls>'.length);
                inBlock = true;
            }
            return output;
        };
    };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    let cachedToolOverrides = null;
    let cachedToolAt = 0;

    const getToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        if (cachedToolOverrides && Date.now() - cachedToolAt < TOOL_IDS_CACHE_MS) {
            return cachedToolOverrides;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data)
                ? idsRes.data
                : Array.isArray(idsRes)
                    ? idsRes
                    : [];
            const overrides = {};
            ids.forEach((id) => {
                /* opencode>=1.19 + zen 免费模型下, 禁用 read/glob 任一会导致 prompt 请求永久挂起, 这两个只读工具保持启用, 其余工具仍禁用 */
                overrides[id] = ["read","glob"].includes(String(id).toLowerCase()) ? true : false;
            });
            cachedToolOverrides = overrides;
            cachedToolAt = Date.now();
            logDebug('Tool overrides loaded', { count: ids.length });
            return overrides;
        } catch (e) {
            logDebug('Tool override fetch failed', { error: e.message });
            return null;
        }
    };

    /**
     * 输出侧兜底: 裁掉 assistant 内容里的系统注入片段(非流式/轮询路径), 命中时 WARN 便于排查
     * @param {string} text 上游汇总出来的 assistant 文本
     * @param {{reqId?: string|null, sessionId?: string|null, channel?: string, source?: string}} meta
     * @returns {string}
     */
    function sanitizeAssistantOutput(text, meta = {}) {
        const result = sanitizeAssistantText(text, echoPatterns);
        if (result.removedChars > 0) {
            logger.warn('[Proxy] System prompt echo removed from output', {
                reqId: meta.reqId || null,
                sessionId: meta.sessionId || null,
                channel: meta.channel || 'content',
                source: meta.source || 'poll',
                markers: result.hits,
                removedChars: result.removedChars
            });
        }
        return result.text;
    }

    /** 尽力删除会话(错误/快速失败收尾), 失败只告警 */
    async function deleteSessionQuietly(sessionId, reqId = null) {
        if (!sessionId) return;
        try {
            await client.session.delete({ path: { id: sessionId } });
            logDebug('Session deleted after failure', { reqId, sessionId });
        } catch (e) {
            logger.warn('[Proxy] Failed to cleanup session on error:', { reqId, sessionId, error: e.message });
        }
    }

    // Chat completions endpoint
    app.post('/v1/chat/completions', async (req, res) => {
        const reqId = req.gatewayLog?.reqId || null;
        const enqueuedAt = Date.now();
        /* 在途注册表: 请求一进来就登记(含排队阶段), 排队进度日志/卡住看门狗/在途查询共用 */
        inflight.register({ reqId, phase: 'queue', startedAt: enqueuedAt });
        try {
            await serialQueue.enqueue(
                () => handleChatCompletion(req, res, reqId, enqueuedAt),
                { timeoutMs: REQUEST_TIMEOUT_MS + 20000, reqId }
            );
        } catch (error) {
            if (isQueueTimeoutError(error)) {
                /* 排队超过 QUEUE_MAX_WAIT_MS: 直接 503, 不再陪着一个卡住的上游请求干等 */
                logger.warn('[Proxy] Queue wait timeout, request rejected', {
                    reqId,
                    waitedMs: error.waitedMs,
                    maxWaitMs: error.maxWaitMs,
                    queueLength: serialQueue.length,
                    inflight: inflight.size
                });
                const queueFailure = buildQueueTimeoutResponse(error);
                if (!res.headersSent) {
                    res.status(queueFailure.status).json(queueFailure.body);
                } else if (!res.writableEnded) {
                    res.end();
                }
                return;
            }
            logger.error('[Proxy] Request Handler Error:', { reqId, message: error.message, stack: error.stack });
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: error.constructor.name } });
            }
        } finally {
            /* 完成/失败/超时/快速失败都必须从在途注册表移除(finally 保证) */
            inflight.remove(reqId);
        }
    });

    /**
     * 处理一次 chat completion(在单并发队列里执行)
     * @param {object} req Express 请求
     * @param {object} res Express 响应
     * @param {string|null} reqId 请求 id
     * @param {number} enqueuedAt 入队时间(用于排队时长)
     */
    async function handleChatCompletion(req, res, reqId, enqueuedAt) {
        let sessionId = null;
        let workdir = null;
        let phase = 'init';
        const requestStartedAt = Date.now();

        /* 阶段切换同时更新在途注册表(R4 进度日志 / R5 在途查询都靠它) */
        const setPhase = (next) => {
            phase = next;
            inflight.update(reqId, { phase: next });
        };

        /* 事件收集统一配置: 输出侧防回显 + 限流快速失败 + 活动上报(进度日志/看门狗) */
        const collectorOptions = (overrides = {}) => ({
            client,
            sessionId,
            reqId,
            timeoutMs: REQUEST_TIMEOUT_MS,
            firstDeltaTimeoutMs: DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
            idleTimeoutMs: EVENT_IDLE_TIMEOUT_MS,
            autoApprovePermission: OPENCODE_AUTO_APPROVE,
            directory: workdir,
            echoPatterns,
            fastFailRetryMs: FAST_FAIL_RETRY_MS,
            onActivity: (activity) => {
                inflight.update(reqId, { lastEvent: activity.type, deltaChars: activity.deltaChars });
            },
            ...overrides
        });

        /* 流式分支的快速失败: 先发一条 SSE error 事件(OpenAI 兼容格式), 再正常结束连接 */
        const sendStreamFastFail = (writeSse, streamedContent, fastFailInfo, modelLabel) => {
            const failure = buildRetryFailure(fastFailInfo);
            writeSse(`data: ${JSON.stringify(failure.body)}\n\n`);
            writeSse('data: [DONE]\n\n');
            logger.warn('[Proxy] Request fast-failed on upstream retry', {
                reqId,
                sessionId,
                model: modelLabel,
                stream: true,
                elapsedMs: Date.now() - requestStartedAt,
                nextInMs: fastFailInfo.nextInMs,
                retryAfterMs: failure.body.error.retry_after_ms,
                message: fastFailInfo.message,
                reason: fastFailInfo.reason,
                keyword: fastFailInfo.keyword || null,
                deltaChars: streamedContent ? streamedContent.length : 0
            });
        };

        try {
            const queueWaitMs = Date.now() - enqueuedAt;
            if (queueWaitMs > 0) {
                logger.info('[Proxy] Queue wait', { reqId, waitedMs: queueWaitMs, queueLength: serialQueue.length });
            }
            logger.debug('Incoming OpenAI request', {
                reqId,
                method: req.method,
                path: req.originalUrl,
                headers: maskHeaders(req.headers),
                body: req.body
            });
            const { messages, model, stream } = req.body;
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: { message: 'messages array is required' } });
            }

            let [pID, mID] = (model || 'opencode/kimi-k2.5-free').split('/');
            if (!mID) { mID = pID; pID = 'opencode'; }
            const modelLabel = `${pID}/${mID}`;
            if (req.gatewayLog) {
                req.gatewayLog.model = modelLabel;
                req.gatewayLog.stream = Boolean(stream);
            }
            /* 模型/流式标记尽早写进在途注册表, 排队/执行阶段都能查出来是谁 */
            inflight.update(reqId, { model: modelLabel, stream: Boolean(stream), queueWaitMs });

            /* 系统提示词分离: role=system 进 body.system; 命中规则的 user 消息也提升到 body.system, 不拼进 parts */
            const built = buildPromptMessages(messages, promptPatterns.disabled ? [] : promptPatterns.patterns);
            const { parts, system: systemMsg, lastUserMsg, stats: promptStats } = built;
            const systemWithGuard = applyToolGuard(systemMsg);

            /* info 级默认输出"收到请求": 即使后面卡住, 也能看到请求确实进来了 */
            logger.info('[Proxy] Request received', {
                reqId,
                model: modelLabel,
                stream: Boolean(stream),
                messages: messages.length,
                lastUser: previewText(lastUserMsg, 120),
                hasSystem: Boolean(systemWithGuard),
                systemChars: systemWithGuard ? systemWithGuard.length : 0,
                promotedSystemMessages: promptStats.promotedCount,
                promotedChars: promptStats.promotedChars,
                parts: parts.length
            });

            if (!parts.length) {
                return res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
            }
            logDebug('Request start', {
                model: modelLabel,
                stream: Boolean(stream),
                userMessages: messages.length,
                system: Boolean(systemMsg),
                lastUserLength: lastUserMsg.length,
                parts: parts.length,
                disableTools: DISABLE_TOOLS,
                promptStats
            });
            if (promptStats.promotedCount > 0) {
                logger.debug('[Proxy] System prompt messages promoted out of user parts', {
                    reqId,
                    promotedCount: promptStats.promotedCount,
                    promotedChars: promptStats.promotedChars,
                    systemChars: systemWithGuard ? systemWithGuard.length : 0
                });
            }

            // Ensure backend is running(阶段日志: 后端就绪 + 耗时)
            setPhase('backend');
            const backendStartedAt = Date.now();
            const backend = await ensureBackend(config);
            workdir = OPENCODE_WORKDIR || backend?.workdir || null;
            logger.info('[Proxy] Backend ready', {
                reqId,
                ms: Date.now() - backendStartedAt,
                spawned: Boolean(backend?.spawnedThisTime),
                workdir: workdir || null
            });

            // Create session(在 OPENCODE_WORKDIR 指定的目录里干活; 未配置时用 jail 空目录)
            setPhase('session');
            const sessionStartedAt = Date.now();
            const sessionParams = workdir ? { query: { directory: workdir } } : {};
            const sessionRes = await client.session.create(sessionParams);
            assertNoUpstreamError(sessionRes, 'Create OpenCode session');
            sessionId = sessionRes.data?.id;
            if (!sessionId) throw new Error('Failed to create OpenCode session (no session id in response)');
            inflight.update(reqId, { sessionId });
            logger.info('[Proxy] Session created', {
                reqId,
                sessionId,
                ms: Date.now() - sessionStartedAt,
                workdir: workdir || null
            });

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    system: systemWithGuard,
                    parts: parts
                }
            };
            if (workdir) promptParams.query = { directory: workdir };
            const toolOverrides = await getToolOverrides();
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                promptParams.body.tools = toolOverrides;
            }
            logger.debug('Upstream payload (final request body to opencode serve)', summarizeUpstreamPayload(promptParams, {
                reqId,
                sessionId,
                model: modelLabel,
                disableTools: DISABLE_TOOLS
            }));

            /*
             * 总超时预算: promptAsync 提交 + SSE 完成等待 + 轮询兜底共用同一个 REQUEST_TIMEOUT_MS,
             * 不会因为"先提交、再等待"叠成两倍; 轮询兜底只拿剩余预算。
             */
            const promptDeadline = Date.now() + REQUEST_TIMEOUT_MS;
            const remainingPromptMs = () => Math.max(0, promptDeadline - Date.now());
            /* 轮询结果的回显裁剪(与旧实现同一套标记, 只是移到了 src/prompt-async.js) */
            const sanitizePolledOutput = (text, channel) => sanitizeAssistantOutput(text, {
                reqId,
                sessionId,
                channel,
                source: 'poll'
            });

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                const id = `chatcmpl-${Date.now()}`;
                const filterContentDelta = createToolCallFilter();
                const filterReasoningDelta = createToolCallFilter();
                let streamedContent = '';
                let streamedReasoning = '';
                let sseChunkCount = 0;

                let clientGone = false;
                res.on('close', () => { clientGone = true; });
                const writeSse = (text) => {
                    if (clientGone || res.writableEnded) return false;
                    res.write(text);
                    return true;
                };

                /* 心跳: 长任务期间定期发 SSE 注释(: ping), 避免客户端/中间层把连接当空闲断开。
                   响应结束/客户端断开/异常路径都会清理, 不依赖业务代码走到固定位置 */
                const heartbeatId = setInterval(() => {
                    writeSse(': ping\n\n');
                }, SSE_HEARTBEAT_MS);
                if (typeof heartbeatId.unref === 'function') heartbeatId.unref();
                res.on('finish', () => clearInterval(heartbeatId));
                res.on('close', () => clearInterval(heartbeatId));

                const sendDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        streamedReasoning += filtered;
                    } else {
                        streamedContent += filtered;
                    }
                    const chunk = {
                        id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelLabel,
                        choices: [{ index: 0, delta: {}, finish_reason: null }]
                    };
                    if (isReasoning) {
                        chunk.choices[0].delta.reasoning_content = filtered;
                    } else {
                        chunk.choices[0].delta.content = filtered;
                    }
                    if (writeSse(`data: ${JSON.stringify(chunk)}\n\n`)) sseChunkCount++;
                };

                /* 可选: 把 opencode 工具进度作为 SSE 注释行输出(默认关闭; 注释行不影响客户端解析) */
                const onToolActivity = OPENCODE_STREAM_TOOLS
                    ? (activity) => {
                        const label = activity.tool ? `${activity.tool} ${activity.status}` : activity.status;
                        const detail = activity.input || activity.output || activity.error || '';
                        writeSse(`: tool ${label}${detail ? ` - ${detail}` : ''}\n\n`);
                    }
                    : null;

                const collector = collectSessionEvents(collectorOptions({ onDelta: sendDelta, onTool: onToolActivity }));
                let collected = null;
                let fastFailInfo = null;
                setPhase('prompt');
                try {
                    await collector.ready;
                    /* 订阅阶段就可能收到 retry 快速失败: 已经失败就不要再发 prompt 了 */
                    fastFailInfo = fastFailInfo || collector.getFastFail();
                    if (!fastFailInfo) {
                        const promptStart = Date.now();
                        try {
                            /*
                             * 提交改用 promptAsync(服务端 204 立即返回, 后台继续跑): 不再用 session.prompt
                             * 占着一条 HTTP 连接等模型跑完, 否则 Node fetch 默认 300s bodyTimeout 会掐断长任务。
                             */
                            const promptResult = await submitPromptAsync(client, promptParams, {
                                timeoutMs: remainingPromptMs(),
                                fastFailPromise: collector.fastFailPromise,
                                reqId,
                                logger
                            });
                            assertNoUpstreamError(promptResult, 'Send prompt');
                            logger.info('[Proxy] Prompt sent', {
                                reqId,
                                sessionId,
                                ms: Date.now() - promptStart,
                                async: true,
                                parts: parts.length,
                                systemChars: systemWithGuard ? systemWithGuard.length : 0
                            });
                        } catch (error) {
                            if (isUpstreamRetryError(error)) {
                                fastFailInfo = error.info;
                            } else {
                                throw error;
                            }
                        }
                    }
                    if (!fastFailInfo) {
                        setPhase('collect');
                        collected = await collector.promise;
                        if (collected && collected.fastFail) fastFailInfo = collected.fastFail;
                    }
                } finally {
                    collector.abort();
                }

                if (fastFailInfo) {
                    sendStreamFastFail(writeSse, streamedContent, fastFailInfo, modelLabel);
                    if (!res.writableEnded) res.end();
                    await deleteSessionQuietly(sessionId, reqId);
                    return;
                }

                /* 提交/生成期的会话级错误(如模型不存在): 没有可轮询的 assistant 消息, 直接按错误收尾 */
                if (collected && collected.sessionError) {
                    const sessionFailure = collected.error || {};
                    const failureText = sessionFailure.data?.message || sessionFailure.message || 'Unknown error';
                    sendDelta(`[Proxy Error] ${sessionFailure.name || 'OpenCodeError'}: ${failureText}`);
                    if (writeSse(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)) sseChunkCount++;
                    writeSse('data: [DONE]\n\n');
                    if (!res.writableEnded) res.end();
                    logger.warn('[Proxy] Upstream session error', {
                        reqId,
                        sessionId,
                        stream: true,
                        elapsedMs: Date.now() - requestStartedAt,
                        message: failureText
                    });
                    await deleteSessionQuietly(sessionId, reqId);
                    return;
                }

                /* 兜底轮询: 必须等到 assistant 本轮终态; 轮询期间收到 retry 快速失败时转成 fastFailInfo 收尾 */
                const pollFallback = () => pollForAssistantResponse({
                    client,
                    sessionId,
                    timeoutMs: remainingPromptMs(),
                    intervalMs: DEFAULT_POLL_INTERVAL_MS,
                    requireDone: true,
                    getFastFail: collector.getFastFail,
                    reqId,
                    logger,
                    sanitize: sanitizePolledOutput
                });

                /* SSE 拿到的是不是"本轮已完成"的确定信号: 空闲/首包/断流/超时都不算 */
                const completionConfirmed = Boolean(
                    collected
                    && collected.reason === 'message-finished'
                    && !collected.error
                    && !collected.timedOut
                    && !collected.noData
                    && !collected.idleTimeout
                    && !collected.sessionError
                );

                try {
                    if (!completionConfirmed) {
                        logger.debug('SSE completion not confirmed, polling until assistant finishes', {
                            reqId,
                            sessionId,
                            reason: collected?.reason || 'none',
                            error: collected?.error?.message || null
                        });
                        const { content, reasoning, error } = await pollFallback();
                        if (error && !content && !reasoning) {
                            sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                        } else {
                            const safeReasoning = stripFunctionCalls(reasoning, false);
                            const safeContent = stripFunctionCalls(content, false);
                            /* 事件流已下发的部分不重复下发(按增量前缀对齐) */
                            const remainingReasoning = safeReasoning && safeReasoning.startsWith(streamedReasoning)
                                ? safeReasoning.slice(streamedReasoning.length)
                                : safeReasoning;
                            const remainingContent = safeContent && safeContent.startsWith(streamedContent)
                                ? safeContent.slice(streamedContent.length)
                                : safeContent;
                            if (remainingReasoning) sendDelta(remainingReasoning, true);
                            if (remainingContent) sendDelta(remainingContent, false);
                        }
                    } else if (collected && !streamedContent && !streamedReasoning) {
                        /* 事件流已完成但没拿到增量(部分版本 SSE 无 delta): 兜底轮询一次取全文再下发 */
                        const { content: polledContent, reasoning: polledReasoning } = await pollFallback();
                        const safePolledReasoning = stripFunctionCalls(polledReasoning, false);
                        const safePolledContent = stripFunctionCalls(polledContent, false);
                        if (safePolledReasoning) sendDelta(safePolledReasoning, true);
                        if (safePolledContent) sendDelta(safePolledContent, false);
                    }
                } catch (error) {
                    if (isUpstreamRetryError(error)) {
                        sendStreamFastFail(writeSse, streamedContent, error.info, modelLabel);
                        if (!res.writableEnded) res.end();
                        await deleteSessionQuietly(sessionId, reqId);
                        return;
                    }
                    throw error;
                }

                if (writeSse(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)) sseChunkCount++;
                writeSse('data: [DONE]\n\n');
                res.end();
                logger.info('[Proxy] Request completed', {
                    reqId,
                    sessionId,
                    model: modelLabel,
                    stream: true,
                    chunks: sseChunkCount,
                    contentChars: streamedContent.length,
                    reasoningChars: streamedReasoning.length,
                    echoRemovedChars: (collected && collected.echoRemovedChars) || 0,
                    totalMs: Date.now() - requestStartedAt,
                    toolCalls: collected?.toolCalls?.length || 0,
                    permissions: collected?.permissions || 0,
                    autoApproved: collected?.autoApproved || 0,
                    finishReason: 'stop'
                });
                logger.debug('[Proxy] Upstream response (stream full text)', {
                    reqId,
                    sessionId,
                    content: streamedContent,
                    reasoning: streamedReasoning
                });
            } else {
                /* 非流式也要订阅事件流: 自动批准 permission(否则工具任务会一直等到超时) + 输出工具活动日志。
                   非流式不关心首包/空闲超时(旧实现就是 0), 否则工具阶段 4s 无文本增量就会提前中断事件流 */
                setPhase('prompt');
                const collector = collectSessionEvents(collectorOptions({ firstDeltaTimeoutMs: 0, idleTimeoutMs: 0 }));
                let pollResult = null;
                let fastFailInfo = null;
                try {
                    await collector.ready;
                    /* 订阅阶段就可能收到 retry 快速失败: 已经失败就不要再发 prompt / 轮询了 */
                    fastFailInfo = fastFailInfo || collector.getFastFail();
                    if (!fastFailInfo) {
                        const promptStart = Date.now();
                        try {
                            /* promptAsync 提交(短调用): 长任务不再占用会被 300s fetch 超时掐断的连接 */
                            const promptResult = await submitPromptAsync(client, promptParams, {
                                timeoutMs: remainingPromptMs(),
                                fastFailPromise: collector.fastFailPromise,
                                reqId,
                                logger
                            });
                            assertNoUpstreamError(promptResult, 'Send prompt');
                            logger.info('[Proxy] Prompt sent', {
                                reqId,
                                sessionId,
                                ms: Date.now() - promptStart,
                                async: true,
                                parts: parts.length,
                                systemChars: systemWithGuard ? systemWithGuard.length : 0
                            });

                            /*
                             * 等待本轮结束: 优先 SSE 完成信号(collector.promise), 事件流断流/静默时由轮询兜底。
                             * 两路同时跑、共用同一个总预算, 谁先给出结论用谁 —— 不会因为 SSE 静默就干等到超时。
                             */
                            setPhase('collect');
                            const pollAbort = new AbortController();
                            const pollPromise = pollForAssistantResponse({
                                client,
                                sessionId,
                                timeoutMs: remainingPromptMs(),
                                intervalMs: DEFAULT_POLL_INTERVAL_MS,
                                requireDone: true,
                                getFastFail: collector.getFastFail,
                                reqId,
                                logger,
                                sanitize: sanitizePolledOutput,
                                signal: pollAbort.signal
                            });
                            const first = await Promise.race([
                                collector.promise.then((collected) => ({ source: 'sse', collected })),
                                pollPromise.then((result) => ({ source: 'poll', result }))
                            ]);
                            if (first.source === 'poll') {
                                pollResult = first.result;
                            } else if (first.collected && first.collected.fastFail) {
                                fastFailInfo = first.collected.fastFail;
                                /* 已拿到快速失败结论: 停掉还在跑的轮询, 只吞掉它的 rejection(不再等它) */
                                pollAbort.abort();
                                pollPromise.catch(() => null);
                            } else if (first.collected && first.collected.sessionError) {
                                pollResult = { content: '', reasoning: '', error: first.collected.error };
                                pollAbort.abort();
                                pollPromise.catch(() => null);
                            } else {
                                /* SSE 已给出本轮终态: 轮询此时会立刻返回最终内容(失败/超时也在这里收尾) */
                                setPhase('poll');
                                pollResult = await pollPromise;
                            }
                        } catch (error) {
                            if (isUpstreamRetryError(error)) {
                                fastFailInfo = error.info;
                            } else {
                                throw error;
                            }
                        }
                    }
                } finally {
                    collector.abort();
                }
                if (!fastFailInfo) {
                    fastFailInfo = collector.getFastFail();
                }
                if (fastFailInfo) {
                    const failure = buildRetryFailure(fastFailInfo);
                    logger.warn('[Proxy] Request fast-failed on upstream retry', {
                        reqId,
                        sessionId,
                        model: modelLabel,
                        stream: false,
                        elapsedMs: Date.now() - requestStartedAt,
                        nextInMs: fastFailInfo.nextInMs,
                        retryAfterMs: failure.body.error.retry_after_ms,
                        message: fastFailInfo.message,
                        reason: fastFailInfo.reason,
                        keyword: fastFailInfo.keyword || null
                    });
                    await deleteSessionQuietly(sessionId, reqId);
                    return res.status(failure.status).json(failure.body);
                }
                const { content, reasoning, error } = pollResult;
                if (error && !content && !reasoning) {
                    return res.status(502).json({
                        error: {
                            message: error.data?.message || error.message || 'OpenCode provider error',
                            type: error.name || 'OpenCodeError'
                        }
                    });
                }
                /* 输出侧兜底: 上游把 user/system 内容当 assistant part 回显时裁掉, 响应里只留真正的 assistant 内容 */
                const safeContent = stripFunctionCalls(sanitizeAssistantOutput(content, { reqId, sessionId, channel: 'content', source: 'poll' }));
                const safeReasoning = stripFunctionCalls(sanitizeAssistantOutput(reasoning, { reqId, sessionId, channel: 'reasoning', source: 'poll' }));

                const responsePayload = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: modelLabel,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: safeContent, reasoning_content: safeReasoning || null },
                        finish_reason: 'stop'
                    }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };
                logger.info('[Proxy] Request completed', {
                    reqId,
                    sessionId,
                    model: modelLabel,
                    stream: false,
                    contentChars: safeContent.length,
                    reasoningChars: safeReasoning.length,
                    totalMs: Date.now() - requestStartedAt,
                    toolCalls: collector.state.toolCalls.size,
                    permissions: collector.state.permissions,
                    autoApproved: collector.state.autoApproved,
                    finishReason: 'stop'
                });
                logger.debug('Upstream response (non-stream full JSON)', {
                    reqId,
                    sessionId,
                    response: responsePayload
                });
                res.json(responsePayload);
            }
        } catch (error) {
            // 上游(opencode serve)调用链失败: error 级必输出, 含停在哪一阶段/状态码/错误体摘要; 完整错误对象放 debug 级
            const upstream = extractUpstreamError(error);
            const isTimeout = Boolean(error.message && error.message.includes('Request timeout'));
            if (isTimeout) {
                logger.warn('[Proxy] Request timed out (stuck phase)', {
                    reqId,
                    sessionId,
                    phase,
                    elapsedMs: Date.now() - requestStartedAt,
                    timeoutMs: REQUEST_TIMEOUT_MS
                });
            }
            logger.error('[Proxy] API Error (upstream call failed)', {
                reqId,
                sessionId,
                phase,
                elapsedMs: Date.now() - requestStartedAt,
                message: error.message,
                status: upstream.status,
                retryAfter: upstream.retryAfter,
                bodySummary: upstream.bodySummary
            });
            logger.debug('[Proxy] Error details', { reqId, sessionId, phase, error });

            if (!res.headersSent) {
                let errorMessage = error.message;
                let statusCode = 500;
                if (error.message && error.message.includes('Request timeout')) {
                    statusCode = 504;
                }
                if (error.message && error.message.includes('ENOENT')) {
                    errorMessage = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
                }
                res.status(statusCode).json({
                    error: {
                        message: errorMessage,
                        type: error.constructor.name
                    }
                });
            } else if (!res.writableEnded) {
                /* 流式已开始(响应头已发)后出错: 主动结束 SSE, 避免客户端一直挂着等数据 */
                res.end();
            }
            await deleteSessionQuietly(sessionId, reqId);
        }
    }

    /* 在途请求查询: 鉴权与其它 /v1 接口一致(走同一个 API_KEY 中间件), 返回当前执行中的请求 */
    app.get('/v1/gateway/inflight', (req, res) => {
        res.json(inflight.snapshot());
    });

    // Health check
    app.get('/health', (req, res) => res.json({
        status: 'ok',
        backend: OPENCODE_SERVER_URL,
        inflight: inflight.size
    }));

    return { app, client, inflight, serialQueue };
}

// Backend management state (per-instance)
const backendState = new Map();

/**
 * 把自动批准规则合并进 opencode 的 OPENCODE_CONFIG_CONTENT(内联配置)。
 * opencode 1.19.5 的 `serve` 没有 `--auto`(传了会 exit 1), 自动批准只能走配置层 permission=allow。
 * @param {string|undefined} existingRaw 现有的 OPENCODE_CONFIG_CONTENT
 * @returns {string} 合并后的 JSON 字符串
 */
function buildAutoApproveConfigContent(existingRaw) {
    let baseConfig = {};
    if (existingRaw && String(existingRaw).trim()) {
        try {
            const parsed = JSON.parse(existingRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                baseConfig = parsed;
            } else {
                logger.warn('[Proxy] Existing OPENCODE_CONFIG_CONTENT is not a JSON object, replaced by auto-approve config');
            }
        } catch (e) {
            // 非法 JSON 不静默丢弃: 告警后以自动批准配置为准
            logger.warn('[Proxy] Existing OPENCODE_CONFIG_CONTENT is invalid JSON, replaced by auto-approve config', { error: e.message });
        }
    }
    const basePermission = baseConfig.permission && typeof baseConfig.permission === 'object' && !Array.isArray(baseConfig.permission)
        ? baseConfig.permission
        : {};
    const permission = { ...basePermission };
    AUTO_APPROVE_PERMISSION_KEYS.forEach((key) => {
        if (permission[key] === undefined) permission[key] = 'allow';
    });
    if (permission['*'] === undefined) permission['*'] = 'allow';
    return JSON.stringify({ ...baseConfig, permission });
}

/**
 * Backend Lifecycle Management
 * @returns {Promise<object>} 后端状态(含 workdir / spawnedThisTime), 供请求阶段日志与 session/prompt 使用
 */
async function ensureBackend(config) {
    const {
        OPENCODE_SERVER_URL,
        OPENCODE_PATH,
        OPENCODE_BIND_HOST,
        USE_ISOLATED_HOME,
        OPENCODE_WORKDIR,
        OPENCODE_AUTO_APPROVE,
        OPENCODE_PRINT_LOGS
    } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null,
            workdir: null,
            spawnedAt: null,
            spawnedThisTime: false
        });
    }

    const state = backendState.get(stateKey);

    if (state.isStarting) {
        // Wait for startup to complete
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL);
                return state;
            } catch (e) { }
        }
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL);
    } catch (err) {
        state.isStarting = true;
        try {
            state.spawnedThisTime = false;
            const backendStartedAt = Date.now();
            logger.info(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

            // Kill existing process if any
            if (state.process) {
                try {
                    state.process.kill();
                } catch (e) { }
            }

            // Cleanup old temp dir
            if (state.jailRoot && fs.existsSync(state.jailRoot)) {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }

            const isWindows = process.platform === 'win32';
            const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
                ? USE_ISOLATED_HOME
                : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
                process.env.OPENCODE_USE_ISOLATED_HOME === '1';

            // On Windows, don't use isolated fake-home to avoid path issues
            // On Unix-like systems, use jail for isolation
            const salt = Math.random().toString(36).substring(7);
            const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
            state.jailRoot = jailRoot;
            const workspace = path.join(jailRoot, 'empty-workspace');

            /* 工作目录: OPENCODE_WORKDIR 优先(真实项目目录, 复杂任务必需), 未配置/不存在时回退 jail 空目录 */
            let workdir = null;
            if (OPENCODE_WORKDIR) {
                const resolvedWorkdir = path.isAbsolute(OPENCODE_WORKDIR)
                    ? OPENCODE_WORKDIR
                    : path.resolve(process.cwd(), OPENCODE_WORKDIR);
                if (fs.existsSync(resolvedWorkdir)) {
                    workdir = resolvedWorkdir;
                } else {
                    logger.warn('[Proxy] OPENCODE_WORKDIR does not exist, fallback to jail workspace', { workdir: resolvedWorkdir });
                }
            }
            const spawnCwd = workdir || workspace;
            state.workdir = spawnCwd;

            let envVars;
            const cwd = spawnCwd;

            if (isWindows) {
                // Windows: use normal user home to avoid opencode storage path issues
                fs.mkdirSync(workspace, { recursive: true });
                envVars = {
                    ...process.env,
                    OPENCODE_PROJECT_DIR: spawnCwd
                };
                logger.info('[Proxy] Running on Windows, using standard user home directory');
            } else {
                fs.mkdirSync(workspace, { recursive: true });

                if (useIsolatedHome) {
                    // Unix-like: use isolated fake-home
                    const fakeHome = path.join(jailRoot, 'fake-home');

                    // Create necessary opencode directories
                    const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                    const storageDir = path.join(opencodeDir, 'storage');
                    const messageDir = path.join(storageDir, 'message');
                    const sessionDir = path.join(storageDir, 'session');

                    [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach(d => {
                        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                    });

                    envVars = {
                        ...process.env,
                        HOME: fakeHome,
                        USERPROFILE: fakeHome,
                        OPENCODE_PROJECT_DIR: spawnCwd
                    };
                    logger.info('[Proxy] Using isolated home for OpenCode');
                } else {
                    envVars = {
                        ...process.env,
                        OPENCODE_PROJECT_DIR: spawnCwd
                    };
                    logger.info('[Proxy] Using real HOME for OpenCode (isolation disabled)');
                }
            }

            const [, , portStr] = OPENCODE_SERVER_URL.split(':');
            const port = portStr ? portStr.split('/')[0] : '4097';
            const resolved = resolveOpencodePath(OPENCODE_PATH);
            const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
            if (resolved.path) {
                logger.info(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
            } else {
                logger.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
            }

            // Cross-platform spawn options
            const useShell = process.platform === 'win32' || !resolved.path ||
                opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
            const spawnOptions = {
                stdio: 'inherit',
                cwd: cwd,
                env: envVars,
                shell: useShell  // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
            };

            // 后端监听地址: OPENCODE_BIND_HOST(默认 127.0.0.1; Docker 内设 0.0.0.0 以便对外暴露 4097)
            const bindHost = OPENCODE_BIND_HOST || '127.0.0.1';
            const spawnArgs = ['serve', '--port', port, '--hostname', bindHost];
            /* 可选: 让 opencode 把自己的日志直接并到容器日志(stdio 已是 inherit) */
            if (OPENCODE_PRINT_LOGS) {
                spawnArgs.push('--print-logs', '--log-level', logger.level === 'debug' ? 'DEBUG' : 'INFO');
            }
            /* 自动批准权限: opencode 1.19.5 serve 无 --auto, 通过内联配置把 permission 规则设为 allow */
            if (OPENCODE_AUTO_APPROVE) {
                envVars[OPENCODE_CONFIG_CONTENT_ENV] = buildAutoApproveConfigContent(envVars[OPENCODE_CONFIG_CONTENT_ENV]);
                logger.info('[Proxy] Auto-approve permissions enabled (config permission=allow + event auto-reply)', {
                    permissionKeys: AUTO_APPROVE_PERMISSION_KEYS
                });
            } else {
                logger.info('[Proxy] Auto-approve permissions disabled (OPENCODE_AUTO_APPROVE=false): permission asks wait for manual approval until timeout');
            }
            logger.info(`[Proxy] Starting OpenCode backend: ${spawnArgs.join(' ')}`, {
                cwd,
                printLogs: Boolean(OPENCODE_PRINT_LOGS),
                autoApprove: Boolean(OPENCODE_AUTO_APPROVE),
                workdir: workdir || null
            });
            state.process = spawn(opencodeBin, spawnArgs, spawnOptions);
            state.spawnedThisTime = true;
            state.spawnedAt = Date.now();

            // Handle spawn errors
            state.process.on('error', (err) => {
                logger.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
                if (err.code === 'ENOENT') {
                    logger.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
                    logger.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
                }
            });

            // Wait for backend to be ready
            let started = false;
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                try {
                    await checkHealth(OPENCODE_SERVER_URL);
                    logger.info('[Proxy] OpenCode backend ready.', { ms: Date.now() - backendStartedAt });
                    started = true;
                    break;
                } catch (e) { }
            }

            if (!started) {
                logger.warn('[Proxy] Backend start timed out.');
                throw new Error('Backend start timeout');
            }
        } finally {
            state.isStarting = false;
        }
    }
    return state;
}

/**
 * SYSTEM_PROMPT_PATTERNS 选项归一: 显式传入(含 null=用默认)优先, 否则读环境变量, 空串视为未配置
 */
function resolvePatternsOption(value) {
    if (value !== undefined) return value;
    const envValue = process.env.SYSTEM_PROMPT_PATTERNS;
    if (envValue !== undefined && String(envValue).trim() !== '') return envValue;
    return null;
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options) {
    const normalizeBool = (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value === 1;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
            if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
        }
        return undefined;
    };

    const disableTools =
        normalizeBool(options.DISABLE_TOOLS) ??
        normalizeBool(options.disableTools) ??
        normalizeBool(process.env.OPENCODE_DISABLE_TOOLS) ??
        false;

    const positiveNumber = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    /* 允许 0 的数值配置: 0 表示关闭对应能力(如 FAST_FAIL_RETRY_MS=0 关闭快速失败阈值) */
    const nonNegativeNumber = (value, fallback) => {
        if (value === undefined || value === null || String(value).trim() === '') return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };

    const config = {
        PORT: options.PORT || 8083,
        API_KEY: options.API_KEY || '',
        OPENCODE_SERVER_URL: options.OPENCODE_SERVER_URL || 'http://127.0.0.1:4097',
        OPENCODE_BIND_HOST: options.OPENCODE_BIND_HOST || options.openCodeBindHost || process.env.OPENCODE_BIND_HOST || '127.0.0.1',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '127.0.0.1',
        // LOG_LEVEL 原始值: index.js 已按 "CLI > env > config.json" 合并传入; 直启/插件场景回退读环境变量
        LOG_LEVEL: options.LOG_LEVEL ?? options.logLevel ?? process.env.LOG_LEVEL ?? null,
        // 日志等级来源(仅用于启动日志展示): index.js 会传入 CLI/env/config.json/fallback
        LOG_LEVEL_SOURCE: options.LOG_LEVEL_SOURCE || null,
        USE_ISOLATED_HOME: typeof options.USE_ISOLATED_HOME === 'boolean'
            ? options.USE_ISOLATED_HOME
            : String(options.USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            options.USE_ISOLATED_HOME === '1' ||
            String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1',
        REQUEST_TIMEOUT_MS: positiveNumber(options.REQUEST_TIMEOUT_MS ?? process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
        DISABLE_TOOLS: disableTools,
        /* 复杂任务支持: opencode 工作目录(默认 jail 空目录, 可配置成真实项目目录) */
        OPENCODE_WORKDIR: options.OPENCODE_WORKDIR ?? process.env.OPENCODE_WORKDIR ?? '',
        /* 自动批准权限(默认开): serve 不支持 --auto, 通过配置 permission=allow + 事件自动回复实现 */
        OPENCODE_AUTO_APPROVE: normalizeBool(options.OPENCODE_AUTO_APPROVE) ??
            normalizeBool(process.env.OPENCODE_AUTO_APPROVE) ??
            true,
        /* 可选: 把工具进度以 SSE 注释行输出(默认关) */
        OPENCODE_STREAM_TOOLS: normalizeBool(options.OPENCODE_STREAM_TOOLS) ??
            normalizeBool(process.env.OPENCODE_STREAM_TOOLS) ??
            false,
        /* 可选: tail opencode 日志文件, 新行以 debug 级转发(默认关) */
        OPENCODE_LOG_TAIL: normalizeBool(options.OPENCODE_LOG_TAIL) ??
            normalizeBool(process.env.OPENCODE_LOG_TAIL) ??
            false,
        OPENCODE_LOG_FILE: options.OPENCODE_LOG_FILE ?? process.env.OPENCODE_LOG_FILE ?? '',
        /* 可选: 让 opencode serve 加 --print-logs, 把自己的日志并进容器日志(默认关) */
        OPENCODE_PRINT_LOGS: normalizeBool(options.OPENCODE_PRINT_LOGS) ??
            normalizeBool(process.env.OPENCODE_PRINT_LOGS) ??
            false,
        /* 系统提示词提升规则: 未配置/空 -> prompt-builder 内置默认标记; 显式 none/off/[] -> 关闭 */
        SYSTEM_PROMPT_PATTERNS: resolvePatternsOption(options.SYSTEM_PROMPT_PATTERNS),
        EVENT_IDLE_TIMEOUT_MS: positiveNumber(options.EVENT_IDLE_TIMEOUT_MS ?? process.env.OPENCODE_EVENT_IDLE_TIMEOUT_MS, DEFAULT_EVENT_IDLE_TIMEOUT_MS),
        SSE_HEARTBEAT_MS: positiveNumber(options.SSE_HEARTBEAT_MS ?? process.env.OPENCODE_SSE_HEARTBEAT_MS, DEFAULT_SSE_HEARTBEAT_MS),
        /* 上游 retry(nextInMs 超阈值或额度类文案)快速失败, 不再等满 REQUEST_TIMEOUT_MS; 0=关闭阈值判断 */
        FAST_FAIL_RETRY_MS: nonNegativeNumber(options.FAST_FAIL_RETRY_MS ?? process.env.FAST_FAIL_RETRY_MS, DEFAULT_FAST_FAIL_RETRY_MS),
        /* 单并发队列的排队上限: 超过直接 503, 避免上游卡住时排队雪崩; 0=不限制 */
        QUEUE_MAX_WAIT_MS: nonNegativeNumber(options.QUEUE_MAX_WAIT_MS ?? process.env.QUEUE_MAX_WAIT_MS, DEFAULT_QUEUE_MAX_WAIT_MS),
        /* 在途请求进度日志间隔; 0=关闭 */
        PROGRESS_LOG_INTERVAL_MS: nonNegativeNumber(options.PROGRESS_LOG_INTERVAL_MS ?? process.env.PROGRESS_LOG_INTERVAL_MS, DEFAULT_PROGRESS_LOG_INTERVAL_MS),
        /* 看门狗判定"卡住"的阈值(超过这么久没有活动就 WARN); 0=关闭 */
        STALL_WARN_MS: nonNegativeNumber(options.STALL_WARN_MS ?? process.env.STALL_WARN_MS, DEFAULT_STALL_WARN_MS),
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1'
    };

    // 日志等级解析(启动即校准, 后续所有日志按此等级输出):
    // 1) LOG_LEVEL(index.js 已按 CLI > env > config.json 解析; 直启/插件场景回退 env)
    // 2) 未显式设置且旧 DEBUG 开关开启时提为 debug(向后兼容) 3) 默认 info; 非法值回退 info 并 warn 告警
    const levelSourceHint = config.LOG_LEVEL_SOURCE
        || (options.LOG_LEVEL !== undefined || options.logLevel !== undefined
            ? 'env/config LOG_LEVEL'
            : (process.env.LOG_LEVEL !== undefined ? 'env LOG_LEVEL' : null));
    let levelResolution = logger.setLevel(config.LOG_LEVEL);
    if (!levelResolution.valid) {
        logger.warn(`Invalid LOG_LEVEL '${levelResolution.requested}', fallback to 'info' (valid values: error/warn/info/debug)`);
    } else if (!levelResolution.explicit && config.DEBUG) {
        levelResolution = logger.setLevel('debug');
    }
    config.LOG_LEVEL = logger.level;
    const levelSource = !levelResolution.explicit
        ? (config.DEBUG ? 'legacy DEBUG flag' : 'default')
        : (levelSourceHint || 'LOG_LEVEL');

    const { app, inflight } = createApp(config);

    /* 可选: tail opencode 日志文件(新行 debug 级转发), 作为"实时看到 opencode 在干什么"的第二路信息 */
    let logTail = null;
    if (config.OPENCODE_LOG_TAIL) {
        const logFile = resolveOpencodeLogFile({ configuredPath: config.OPENCODE_LOG_FILE, logger });
        if (logFile) {
            logTail = startOpencodeLogTail({ filePath: logFile, logger });
        } else {
            logger.warn('[opencode][log] OPENCODE_LOG_TAIL=true but no opencode log file found, tail disabled');
        }
    }

    const server = app.listen(config.PORT, config.BIND_HOST, async () => {
        logger.info(`Log level: ${logger.level} (source: ${levelSource})`);
        logger.info(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        logger.info('[Proxy] Runtime options', {
            workdir: config.OPENCODE_WORKDIR || '(jail empty workspace)',
            autoApprovePermissions: config.OPENCODE_AUTO_APPROVE,
            streamToolProgress: config.OPENCODE_STREAM_TOOLS,
            printOpencodeLogs: config.OPENCODE_PRINT_LOGS,
            tailOpencodeLog: Boolean(logTail),
            requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
            eventIdleTimeoutMs: config.EVENT_IDLE_TIMEOUT_MS,
            sseHeartbeatMs: config.SSE_HEARTBEAT_MS,
            fastFailRetryMs: config.FAST_FAIL_RETRY_MS,
            queueMaxWaitMs: config.QUEUE_MAX_WAIT_MS,
            progressLogIntervalMs: config.PROGRESS_LOG_INTERVAL_MS,
            stallWarnMs: config.STALL_WARN_MS
        });
        try {
            await ensureBackend(config);
        } catch (error) {
            logger.error('[Proxy] Backend warmup failed:', { error: error.message });
        }
    });

    /* 服务关闭时清理在途注册表的定时器(看门狗 + 每请求进度定时器), 不泄漏 */
    server.on('close', () => inflight.stop());

    return {
        server,
        stopLogTail: () => {
            if (logTail) {
                logTail.stop();
                logTail = null;
            }
        },
        killBackend: () => {
            if (logTail) {
                logTail.stop();
                logTail = null;
            }
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (state && state.process) {
                state.process.kill();
            }
            // Cleanup temp dir (only on non-Windows where we use jail)
            if (state && state.jailRoot && process.platform !== 'win32') {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }
        }
    };
}
