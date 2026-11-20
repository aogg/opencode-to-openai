/**
 * OpenCode 日志文件 tail(opencode-to-openai 网关)
 *
 * 用途: 让用户"实时看到 opencode 在干什么"的第二路信息来源。
 * 主路径是 SSE 事件流(src/opencode-events.js); 这里是可选的文件 tail:
 *   OPENCODE_LOG_TAIL=true           开启(默认 false)
 *   OPENCODE_LOG_FILE=/path/to.log   显式指定; 留空自动探测
 * 自动探测顺序: OPENCODE_LOG_FILE > $XDG_DATA_HOME/opencode/log/opencode.log
 *             > ~/.local/share/opencode/log/opencode.log > 该目录下最新的 *.log
 * 新行统一以 debug 级转发(避免刷屏), 前缀 [opencode][log]。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_LINES_PER_TICK = 40;
const MAX_LINE_LENGTH = 2000;

/** 展开 ~ 开头的路径 */
function expandHome(input) {
    const value = String(input || '');
    if (!value) return value;
    if (value === '~') return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

/** 在某目录下找最新的 *.log(找不到返回 null) */
function findNewestLogFile(dir, logger) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        logger.debug('[opencode][log] log dir not readable', { dir, error: e.message });
        return null;
    }
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .map((entry) => {
            const full = path.join(dir, entry.name);
            try {
                return { full, mtimeMs: fs.statSync(full).mtimeMs };
            } catch (e) {
                logger.debug('[opencode][log] stat log file failed', { file: full, error: e.message });
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.length ? files[0].full : null;
}

/**
 * 解析要 tail 的 opencode 日志文件
 * @param {{configuredPath?: string, logger: object}} options
 * @returns {string|null}
 */
export function resolveOpencodeLogFile(options = {}) {
    const { configuredPath = '', logger } = options;
    const explicit = expandHome(configuredPath);
    if (explicit) {
        if (fs.existsSync(explicit)) return explicit;
        logger.warn('[opencode][log] OPENCODE_LOG_FILE not found, fallback to auto-detect', { file: explicit });
    }

    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const candidates = [
        path.join(dataHome, 'opencode', 'log', 'opencode.log'),
        path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return findNewestLogFile(path.join(dataHome, 'opencode', 'log'), logger);
}

/**
 * 启动日志文件 tail
 * @param {{filePath: string, logger: object, intervalMs?: number, maxLinesPerTick?: number}} options
 * @returns {{filePath: string, stop: Function, offset: Function}}
 */
export function startOpencodeLogTail(options) {
    const {
        filePath,
        logger,
        intervalMs = DEFAULT_INTERVAL_MS,
        maxLinesPerTick = DEFAULT_MAX_LINES_PER_TICK
    } = options;

    let offset = 0;
    let pending = '';
    let stopped = false;
    let timer = null;
    let missingWarned = false;

    try {
        offset = fs.statSync(filePath).size;
    } catch (e) {
        // 启动瞬间文件可能刚被轮转; 从 0 开始读并在后续 tick 重试, 这里只记录原因
        logger.warn('[opencode][log] cannot stat log file at startup, will retry from 0', {
            file: filePath,
            error: e.message
        });
        offset = 0;
    }

    logger.info('[opencode][log] tailing opencode log file', { file: filePath, fromOffset: offset });

    function readNewBytes() {
        let stat = null;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            if (!missingWarned) {
                missingWarned = true;
                logger.warn('[opencode][log] log file not accessible, tail paused until it appears', {
                    file: filePath,
                    error: e.message
                });
            }
            return;
        }
        if (missingWarned) {
            missingWarned = false;
            logger.info('[opencode][log] log file is accessible again', { file: filePath });
        }
        if (stat.size < offset) {
            // 文件被截断/轮转: 从头开始
            logger.debug('[opencode][log] log file truncated, restart from 0', { file: filePath, size: stat.size });
            offset = 0;
            pending = '';
        }
        if (stat.size === offset) return;

        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        let fd = null;
        try {
            fd = fs.openSync(filePath, 'r');
            const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
            offset += bytesRead;
            pending += buffer.slice(0, bytesRead).toString('utf8');
        } catch (e) {
            // 读取失败不静默: 记录原因, 下一 tick 重试(offset 未推进, 不会丢行)
            logger.warn('[opencode][log] read log file failed', { file: filePath, error: e.message });
            return;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    logger.debug('[opencode][log] close log file failed', { file: filePath, error: e.message });
                }
            }
        }

        const lines = pending.split('\n');
        pending = lines.pop() || '';
        const emit = lines.slice(-maxLinesPerTick);
        const skipped = lines.length - emit.length;
        if (skipped > 0) {
            logger.debug('[opencode][log] skipped log lines due to per-tick limit', { file: filePath, skipped });
        }
        emit.forEach((line) => {
            const text = line.replace(/\r$/, '').trim();
            if (!text) return;
            logger.debug(`[opencode][log] ${text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text}`);
        });
    }

    timer = setInterval(() => {
        if (stopped) return;
        try {
            readNewBytes();
        } catch (e) {
            // 定时任务不能抛: 记录原因(含堆栈首行), 保持 tail 存活
            logger.warn('[opencode][log] tail tick failed', { file: filePath, error: e.message });
        }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        filePath,
        offset: () => offset,
        stop: () => {
            if (stopped) return;
            stopped = true;
            if (timer) clearInterval(timer);
            timer = null;
            logger.info('[opencode][log] stopped tailing opencode log file', { file: filePath });
        }
    };
}
