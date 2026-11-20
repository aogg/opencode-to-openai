/**
 * 系统提示词分离 + OpenCode prompt parts 构建(opencode-to-openai 网关)
 *
 * 背景: 部分客户端(如 dsh)会把"角色注入 / 项目系统提示词 / system-reminder / 技能列表"
 * 当作 role=user 的消息发给网关。若直接拼进 user parts, 模型会复述系统提示词、被带偏。
 * 这里把命中 SYSTEM_PROMPT_PATTERNS 的 user 消息内容提升到 prompt body.system,
 * 不再进入 parts; role=system 的既有路径不受影响。
 */

/** 默认识别的系统注入标记(正则字符串; 匹配对象是消息内容 trim 后的开头) */
export const DEFAULT_SYSTEM_PROMPT_PATTERNS = [
    '^# 角色注入',
    '^<system-reminder>',
    '^【会话自动搬移已开启】',
    '^Current runtime context',
    '^# 项目系统提示词',
    '^Time sampled while preparing turn'
];

/** 关闭提升的特殊取值 */
const DISABLED_VALUES = new Set(['', 'none', 'off', 'false', '0', '[]']);

/**
 * 解析 SYSTEM_PROMPT_PATTERNS 配置
 * 支持: JSON 数组字符串 / 分号分隔 / 换行分隔 / (无分号换行时)逗号分隔 / 已是数组
 * 注意: 正则本身可能含逗号(如 a{1,2}), 因此优先按分号/换行切分, 只有完全没有分号换行时才按逗号切分
 * @param {string|string[]|null|undefined} raw
 * @returns {{patterns: RegExp[], sources: string[], invalid: {pattern: string, error: string}[], disabled: boolean, configured: boolean}}
 */
export function parseSystemPromptPatterns(raw) {
    const result = { patterns: [], sources: [], invalid: [], disabled: false, configured: false };

    let items = null;
    if (Array.isArray(raw)) {
        result.configured = true;
        items = raw.map((v) => String(v));
    } else if (typeof raw === 'string') {
        result.configured = true;
        const trimmed = raw.trim();
        if (DISABLED_VALUES.has(trimmed.toLowerCase())) {
            result.disabled = true;
            return result;
        }
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    items = parsed.map((v) => String(v));
                } else {
                    result.invalid.push({ pattern: trimmed.slice(0, 80), error: 'JSON 不是数组, 回退默认模式' });
                }
            } catch (e) {
                result.invalid.push({ pattern: trimmed.slice(0, 80), error: `JSON 解析失败: ${e.message}` });
            }
        }
        if (!items) {
            const hasSemicolonOrNewline = /[;\n]/.test(trimmed);
            const separator = hasSemicolonOrNewline ? /[;\n]+/ : /,/;
            items = trimmed.split(separator).map((v) => v.trim()).filter(Boolean);
        }
    }

    if (!items) {
        // 未配置: 使用内置默认标记集合
        items = DEFAULT_SYSTEM_PROMPT_PATTERNS;
        result.configured = false;
    }

    items.forEach((pattern) => {
        const text = String(pattern).trim();
        if (!text) return;
        try {
            result.patterns.push(new RegExp(text));
            result.sources.push(text);
        } catch (e) {
            // 非法正则不静默丢弃: 记录到 invalid 由调用方告警
            result.invalid.push({ pattern: text, error: e.message });
        }
    });

    return result;
}

/**
 * 归一化 OpenAI message.content(字符串 / 数组多段 / 对象)
 * @param {*} content
 * @returns {string}
 */
export function normalizeMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            })
            .join('');
    }
    if (content && typeof content.text === 'string') return content.text;
    if (content === null || content === undefined) return '';
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    return '';
}

/** 是否命中系统注入标记 */
function matchesSystemPattern(content, patterns) {
    if (!patterns || patterns.length === 0) return false;
    const text = String(content).trim();
    if (!text) return false;
    return patterns.some((re) => re.test(text));
}

/**
 * 构建 prompt 的 parts 与 system
 * @param {Array} messages OpenAI messages 数组
 * @param {RegExp[]} patterns 系统提示词提升正则(空数组=不提升)
 * @returns {{parts: Array<{type:'text', text:string}>, system: string,
 *            lastUserMsg: string, stats: object}}
 */
export function buildPromptMessages(messages, patterns = []) {
    const entries = [];
    (Array.isArray(messages) ? messages : []).forEach((m, index) => {
        const role = String(m?.role || 'user').toLowerCase();
        const content = normalizeMessageContent(m?.content);
        if (!content || !content.trim()) return;
        entries.push({ role, name: m?.name || null, content, index });
    });

    const promoted = [];
    const systemChunks = [];
    const parts = [];
    let userCount = 0;

    const pushSystem = (text) => {
        // system 内容去重: 同一段系统注入只保留一次
        if (systemChunks.includes(text)) return;
        systemChunks.push(text);
    };

    entries.forEach((entry) => {
        if (entry.role === 'system') {
            pushSystem(entry.content);
            return;
        }
        if (entry.role === 'user') {
            userCount += 1;
            if (matchesSystemPattern(entry.content, patterns)) {
                promoted.push(entry);
                return;
            }
        }
        const nameSuffix = entry.name ? `(${entry.name})` : '';
        parts.push({ type: 'text', text: `${entry.role.toUpperCase()}${nameSuffix}: ${entry.content}` });
    });

    // 极端情况: 全部 user 消息都被提升 -> parts 为空(上游会拒绝)。
    // 此时把最后一条被提升的用户消息放回 parts, 保证模型有用户输入, 且不重复(它不再进 system)。
    let rescued = false;
    if (promoted.length > 0 && parts.length === 0) {
        const rescue = promoted.pop();
        const nameSuffix = rescue.name ? `(${rescue.name})` : '';
        parts.push({ type: 'text', text: `USER${nameSuffix}: ${rescue.content}` });
        rescued = true;
    }

    promoted.forEach((entry) => pushSystem(entry.content));

    // 最后一条"真正的用户消息"用于日志摘要(优先未被提升的, 全被提升时取被提升的最后一条)
    let lastUserMsg = '';
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.role !== 'user') continue;
        if (promoted.includes(entry) && parts.length > 0) continue;
        lastUserMsg = entry.content;
        break;
    }
    if (!lastUserMsg && promoted.length) {
        lastUserMsg = promoted[promoted.length - 1].content;
    }

    const system = systemChunks.join('\n\n');
    const promotedChars = promoted.reduce((sum, entry) => sum + entry.content.length, 0);

    return {
        parts,
        system,
        lastUserMsg,
        stats: {
            messageCount: entries.length,
            userCount,
            systemMessageCount: entries.filter((e) => e.role === 'system').length,
            promotedCount: promoted.length,
            promotedChars,
            systemChars: system.length,
            partsCount: parts.length,
            rescuedUserMessage: rescued
        }
    };
}

/**
 * 单行预览: 压掉换行 + 截断, 用于日志
 * @param {*} value
 * @param {number} maxLen
 */
export function previewText(value, maxLen = 120) {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…(+${text.length - maxLen} chars)`;
}

/**
 * prompt parts 摘要(debug 日志用): 数量 + 每条长度 + 预览
 * @param {Array<{type:string,text?:string}>} parts
 * @param {number} previewLen
 */
export function summarizeParts(parts, previewLen = 120) {
    if (!Array.isArray(parts)) return [];
    return parts.map((part, index) => ({
        index,
        type: part?.type || 'unknown',
        chars: typeof part?.text === 'string' ? part.text.length : 0,
        preview: previewText(part?.text, previewLen)
    }));
}

/**
 * 最终 upstream payload 摘要(debug 日志用): 不打印完整 parts, 只打印结构 + 预览
 * @param {object} promptParams client.session.prompt 的参数
 * @param {object} extra 额外上下文(reqId/sessionId/model/disableTools)
 */
export function summarizeUpstreamPayload(promptParams, extra = {}) {
    const body = promptParams?.body || {};
    const system = typeof body.system === 'string' ? body.system : '';
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const tools = body.tools && typeof body.tools === 'object' ? body.tools : null;
    return {
        ...extra,
        model: body.model || null,
        directory: promptParams?.query?.directory || null,
        systemChars: system.length,
        systemPreview: previewText(system, 200),
        partsCount: parts.length,
        parts: summarizeParts(parts),
        tools: tools ? { total: Object.keys(tools).length, enabled: Object.keys(tools).filter((k) => tools[k]) } : null
    };
}
