/**
 * 命令行参数解析 + 日志等级优先级解析(opencode-to-openai 网关)
 *
 * 用法:
 *   node index.js --log-level debug
 *   node index.js --log-level=debug
 *
 * 日志等级优先级(高 -> 低):
 *   CLI --log-level > env LOG_LEVEL > config.json 的 LOG_LEVEL > 旧 DEBUG 开关 > 默认 info
 * 任一层给出非法值时: 输出告警并继续尝试下一优先级, 全部无效则回退 info。
 */

import { resolveLogLevel } from './logger.js';

/**
 * 解析 CLI 参数(只关心日志相关参数, 其余参数容忍并记录, 不影响启动)
 * @param {string[]} argv 形如 process.argv.slice(2)
 * @returns {{logLevel: string|null, help: boolean, unknown: string[], errors: string[]}}
 */
export function parseCliArgs(argv = []) {
    const result = { logLevel: null, help: false, unknown: [], errors: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i]);
        if (arg === '--log-level') {
            const next = argv[i + 1];
            if (next === undefined || String(next).startsWith('--')) {
                result.errors.push('--log-level 缺少参数值, 已忽略');
                continue;
            }
            result.logLevel = String(next);
            i += 1;
            continue;
        }
        if (arg.startsWith('--log-level=')) {
            result.logLevel = arg.slice('--log-level='.length);
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            result.help = true;
            continue;
        }
        result.unknown.push(arg);
    }
    return result;
}

/** CLI 使用说明 */
export function usageText() {
    return [
        'opencode-to-openai - OpenAI 兼容网关(OpenCode CLI 后端)',
        '',
        '用法: node index.js [选项]',
        '',
        '选项:',
        '  --log-level <error|warn|info|debug>  日志等级, 等价写法 --log-level=debug',
        '  -h, --help                           显示本帮助',
        '',
        '环境变量(日志相关):',
        '  LOG_LEVEL=<等级>                     优先级低于 CLI, 高于 config.json',
        '',
        '日志等级优先级: CLI > env LOG_LEVEL > config.json LOG_LEVEL > 旧 DEBUG 开关 > 默认 info'
    ].join('\n');
}

/**
 * SYSTEM_PROMPT_PATTERNS 取值: env > config.json; 两者都为空时返回 null(用内置默认标记)
 * 注意: 只有显式写 "none"/"off"/"false"/"0"/"[]" 才算关闭提升, 空字符串按"未配置"处理
 * (入口脚本生成的 config.json 里就是空串, 不能把默认提升能力关掉)
 */
export function resolvePatternsSetting(envValue, fileValue) {
    if (envValue !== undefined && envValue !== null && String(envValue).trim() !== '') return envValue;
    if (fileValue !== undefined && fileValue !== null && String(fileValue).trim() !== '') return fileValue;
    return null;
}

/**
 * 解析最终生效的日志等级
 * @param {{cliLevel?: string|null, envLevel?: string|null, fileLevel?: string|null, legacyDebug?: boolean}} sources
 * @returns {{level: string, source: string, warnings: string[], requested: string|null}}
 */
export function resolveLogLevelSettings(sources = {}) {
    const { cliLevel, envLevel, fileLevel, legacyDebug = false } = sources;
    const warnings = [];
    const candidates = [
        { source: 'CLI --log-level', raw: cliLevel },
        { source: 'env LOG_LEVEL', raw: envLevel },
        { source: 'config.json LOG_LEVEL', raw: fileLevel }
    ];

    for (const candidate of candidates) {
        if (candidate.raw === undefined || candidate.raw === null) continue;
        // 空字符串视为"未设置", 不告警(例如 docker -e LOG_LEVEL= 的常见写法)
        if (typeof candidate.raw === 'string' && candidate.raw.trim() === '') continue;
        const parsed = resolveLogLevel(candidate.raw);
        if (parsed.valid) {
            return { level: parsed.level, source: candidate.source, warnings, requested: String(candidate.raw) };
        }
        warnings.push(`Invalid log level '${candidate.raw}' from ${candidate.source}, ignored (valid values: error/warn/info/debug)`);
    }

    if (legacyDebug) {
        return { level: 'debug', source: 'legacy DEBUG flag', warnings, requested: 'debug' };
    }
    return { level: 'info', source: 'default', warnings, requested: null };
}
