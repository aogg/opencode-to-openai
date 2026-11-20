/**
 * 输出侧兜底过滤(系统提示词零回显 · defense in depth)
 *
 * 背景: 上游 opencode 偶尔会把客户端注入的 user/system 内容当成 assistant part 回显,
 * 导致 API 响应里出现 "# 角色注入 / # 项目系统提示词 / system-reminder" 之类的系统提示词。
 * 事件层已按 message 角色过滤(见 src/opencode-events.js), 这里再做一层"输出卫生":
 * - 复用 SYSTEM_PROMPT_PATTERNS 的匹配逻辑(与 prompt-builder 同一套正则解析, 含 none/off 关闭)
 * - 额外加上网关自己拼 parts 用的角色前缀("USER: xxx" / "SYSTEM(名称): xxx")与常见注入标记
 * - 非流式/轮询路径: 按整段文本裁剪(sanitizeAssistantText)
 * - 流式路径: 逐增量裁剪(createStreamEchoFilter); 只对"行首"做缓冲判定, 正常文本零额外延迟
 *
 * 标记只按行首匹配: 系统注入内容都是以这些标记开头的一段文本, 行中出现不处理, 避免误伤正常回答。
 */

import { DEFAULT_SYSTEM_PROMPT_PATTERNS, parseSystemPromptPatterns } from './prompt-builder.js';

/**
 * 网关拼 prompt parts 时的角色前缀格式(`${role.toUpperCase()}: ${content}`),
 * 命中它基本可以确定是 prompt 原文回显(正常回答不会以 "USER: " 开头)。
 */
export const ECHO_ROLE_PREFIX_SOURCE =
    '^(?:USER|SYSTEM|SYSTEM-REMINDER|SYSTEM_REMINDER|ASSISTANT)\\s*(?:\\([^)\\n]{1,80}\\))?\\s*[:：]';

/** 角色前缀的判定线索: 行首还是这些字符串的前缀时继续缓冲, 其它文本立即放行(不增加首包延迟) */
const ECHO_ROLE_LEADS = ['USER', 'SYSTEM', 'SYSTEM-REMINDER', 'SYSTEM_REMINDER', 'ASSISTANT'];

/**
 * 额外兜底标记: 即使 SYSTEM_PROMPT_PATTERNS 被关掉也保留,
 * 它们属于网关自身的输出卫生(角色前缀 + dsh 常见注入标记)。
 */
export const EXTRA_ECHO_SOURCES = [
    ECHO_ROLE_PREFIX_SOURCE,
    '^<system-reminder>',
    '^【会话自动搬移已开启】',
    '^Current runtime context',
    '^# 项目系统提示词',
    '^# 角色注入',
    '^Time sampled while preparing turn'
];

/** 流式判定行首时最多缓冲的字符数(超限就放行, 宁可漏判也不拖慢首包) */
const DEFAULT_MAX_HOLD_CHARS = 64;

/** 正则元字符: 推导"字面量前缀"时遇到即停止 */
const REGEX_META = new Set(['\\', '[', ']', '(', ')', '{', '}', '.', '*', '+', '?', '$', '^', '|']);

/**
 * 从正则字符串推导字面量前缀, 用于判断"当前行首还可能长成标记"(例如 "^# 角色注入" -> "# 角色注入")
 * 推导不出来(以分组/字符类开头)时返回空串。
 * @param {string} source
 * @returns {string}
 */
export function literalPrefixOf(source) {
    let text = String(source || '');
    if (text.startsWith('^')) text = text.slice(1);
    let out = '';
    for (const ch of text) {
        if (REGEX_META.has(ch)) break;
        out += ch;
    }
    return out;
}

/**
 * 编译标记集合(去重; 非法正则由 prompt-builder 统一告警, 这里静默跳过)
 * @param {string[]} sources
 * @returns {{source: string, re: RegExp, literal: string, leads: string[]}[]}
 */
function compilePatterns(sources) {
    const list = [];
    const seen = new Set();
    (Array.isArray(sources) ? sources : []).forEach((raw) => {
        const source = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!source || seen.has(source)) return;
        try {
            list.push({
                source,
                re: new RegExp(source),
                literal: literalPrefixOf(source),
                leads: source === ECHO_ROLE_PREFIX_SOURCE ? ECHO_ROLE_LEADS : []
            });
            seen.add(source);
        } catch (e) {
            // 非法正则: prompt-builder 已在上层告警(invalid), 这里跳过即可
        }
    });
    return list;
}

/**
 * 构建输出侧标记集合
 * @param {string|string[]|null|undefined} rawPatterns SYSTEM_PROMPT_PATTERNS 原始配置(未配置/空 -> 内置默认)
 * @returns {{source: string, re: RegExp, literal: string, leads: string[]}[]}
 */
export function buildEchoPatterns(rawPatterns) {
    const parsed = parseSystemPromptPatterns(rawPatterns);
    const configured = parsed.disabled ? [] : parsed.sources;
    /* 配置里没给(或关闭)时仍要加额外兜底标记; 配置给了就以配置为准 + 额外标记 */
    const merged = parsed.configured && !parsed.disabled
        ? [...configured, ...EXTRA_ECHO_SOURCES]
        : [...DEFAULT_SYSTEM_PROMPT_PATTERNS, ...EXTRA_ECHO_SOURCES];
    return compilePatterns(merged);
}

/** 归一化标记集合: 接受编译后的对象数组 / 正则数组 / 字符串数组 */
function normalizePatterns(patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return buildEchoPatterns(null);
    if (patterns.every((item) => item && typeof item === 'object' && item.re instanceof RegExp)) return patterns;
    const sources = patterns.map((item) => {
        if (item instanceof RegExp) return item.source;
        if (item && typeof item === 'object' && item.re instanceof RegExp) return item.re.source;
        return String(item);
    });
    return compilePatterns(sources);
}

/**
 * 判断某一行(已去左侧空白)是否命中系统注入标记
 * @param {string} line
 * @param {object[]} compiled normalizePatterns 的结果
 * @returns {string|null} 命中的标记源码
 */
function matchLineSource(line, compiled) {
    const trimmed = String(line === null || line === undefined ? '' : line).replace(/^\s+/, '');
    if (!trimmed) return null;
    for (const pattern of compiled) {
        if (pattern.re.test(trimmed)) return pattern.source;
    }
    return null;
}

/**
 * 在整段文本里找第一个系统注入标记(按行首匹配)
 * @param {string} text
 * @param {object[]|string[]} patterns
 * @returns {{index: number, marker: string, line: string}|null}
 */
export function findEchoMarker(text, patterns) {
    const value = typeof text === 'string' ? text : '';
    if (!value) return null;
    const compiled = normalizePatterns(patterns);
    let offset = 0;
    for (const line of value.split('\n')) {
        const trimmed = line.replace(/^\s+/, '');
        if (trimmed) {
            const marker = matchLineSource(line, compiled);
            if (marker) return { index: offset + (line.length - trimmed.length), marker, line };
        }
        offset += line.length + 1;
    }
    return null;
}

/**
 * 整段文本裁剪(非流式/轮询路径)
 * 规则:
 * 1) 第一个非空行就命中标记 -> 整段视为 prompt 回显, 全部裁掉;
 * 2) 标记出现在正文中间 -> 只删命中的行, 保留其它正常内容。
 * @param {string} text
 * @param {object[]|string[]} [patterns]
 * @returns {{text: string, removedChars: number, hits: string[]}}
 */
export function sanitizeAssistantText(text, patterns) {
    const value = typeof text === 'string' ? text : '';
    if (!value) return { text: '', removedChars: 0, hits: [] };
    const compiled = normalizePatterns(patterns);
    const first = findEchoMarker(value, compiled);
    if (!first) return { text: value, removedChars: 0, hits: [] };

    /* 开头就是注入标记: 整段丢弃(回显的系统提示词不可能是"部分正常内容") */
    if (!value.slice(0, first.index).trim()) {
        return { text: '', removedChars: value.length, hits: [first.marker] };
    }

    const kept = [];
    const hits = [];
    value.split('\n').forEach((line) => {
        const marker = matchLineSource(line, compiled);
        if (marker) {
            hits.push(marker);
            return;
        }
        kept.push(line);
    });
    const result = kept.join('\n');
    return { text: result, removedChars: value.length - result.length, hits };
}

/**
 * 当前行首是否还可能长成某个标记(用于决定要不要继续缓冲)
 * @param {string} prefix 已去左侧空白的行首片段
 * @param {object[]} compiled
 */
function couldStartMarker(prefix, compiled) {
    const text = String(prefix || '');
    if (!text) return true;
    const upper = text.toUpperCase();
    for (const pattern of compiled) {
        if (pattern.re.test(text)) return true;
        if (pattern.literal && pattern.literal.startsWith(text)) return true;
        if (pattern.leads.length && pattern.leads.some((lead) => {
            const leadUpper = lead.toUpperCase();
            return leadUpper.startsWith(upper) || upper.startsWith(leadUpper);
        })) {
            return true;
        }
    }
    return false;
}

/**
 * 创建流式输出过滤器(每个增量调用一次 filter, 结束时必须调用 flush)
 *
 * 行为:
 * - 流开头先缓冲一小段(或首行), 判定是否是 prompt 回显; 命中的整段丢弃并回调节
 * - 透传阶段逐行检查行首, 命中标记的行删掉, 其它内容原样输出
 * - 判定只看行首, 正常文本(行首不是角色名/注入标记前缀)立即放行, 不拖慢首包
 *
 * @param {object} [options]
 * @param {object[]|string[]} [options.patterns] 标记集合(默认内置)
 * @param {number} [options.maxHoldChars] 行首最多缓冲字符数
 * @param {Function|null} [options.onHit] 首次命中某标记时回调({marker, removedChars, phase})
 * @returns {{filter: Function, flush: Function, stats: Function}}
 */
export function createStreamEchoFilter(options = {}) {
    const compiled = normalizePatterns(options.patterns);
    const maxHoldChars = Number.isFinite(options.maxHoldChars) && options.maxHoldChars > 0
        ? options.maxHoldChars
        : DEFAULT_MAX_HOLD_CHARS;
    const onHit = typeof options.onHit === 'function' ? options.onHit : null;

    const state = {
        mode: 'start',       // start=首行判定中; pass=正常透传; blocked=整段丢弃
        hold: '',            // start 阶段缓冲
        lineStart: true,     // pass 阶段: 是否位于行首
        linePrefix: '',      // pass 阶段: 行首待判定片段
        removedChars: 0,
        blocked: false,
        hits: new Set()
    };

    function record(markerSource, chars, phase) {
        state.removedChars += chars;
        if (!state.hits.has(markerSource)) {
            state.hits.add(markerSource);
            if (onHit) {
                try {
                    onHit({ marker: markerSource, removedChars: chars, phase });
                } catch (e) {
                    // 回调异常不影响输出
                }
            }
        }
    }

    /** start 阶段判定: blocked / pass / hold */
    function decideStart(buffer) {
        const trimmed = buffer.replace(/^\s+/, '');
        if (!trimmed) return 'hold';
        const marker = matchLineSource(buffer, compiled);
        if (marker) return 'blocked';
        if (buffer.includes('\n')) return 'pass';
        if (trimmed.length >= maxHoldChars) return 'pass';
        if (couldStartMarker(trimmed, compiled)) return 'hold';
        return 'pass';
    }

    /** pass 阶段处理一块增量, 返回可下发文本 */
    function processPass(chunk) {
        let output = '';
        let index = 0;
        while (index < chunk.length) {
            if (state.lineStart) {
                const newline = chunk.indexOf('\n', index);
                const segmentEnd = newline === -1 ? chunk.length : newline + 1;
                state.linePrefix += chunk.slice(index, segmentEnd);
                index = segmentEnd;
                if (newline !== -1) {
                    /* 一整行(含换行)到齐: 判定后决定输出还是丢弃 */
                    const line = state.linePrefix.slice(0, -1);
                    const marker = matchLineSource(line, compiled);
                    if (marker) {
                        record(marker, state.linePrefix.length, 'line');
                    } else {
                        output += state.linePrefix;
                    }
                    state.linePrefix = '';
                    state.lineStart = true;
                    continue;
                }
                /* 行还没结束: 行首可能还是标记前缀就继续缓冲, 否则放行 */
                const trimmed = state.linePrefix.replace(/^\s+/, '');
                if (!couldStartMarker(trimmed, compiled) || state.linePrefix.length >= maxHoldChars) {
                    output += state.linePrefix;
                    state.linePrefix = '';
                    state.lineStart = false;
                }
                continue;
            }
            /* 行中: 直接输出到下一个换行(标记只可能出现在行首) */
            const newline = chunk.indexOf('\n', index);
            const segmentEnd = newline === -1 ? chunk.length : newline + 1;
            output += chunk.slice(index, segmentEnd);
            index = segmentEnd;
            if (newline !== -1) state.lineStart = true;
        }
        return output;
    }

    /** 冲刷 pass 阶段残留的行首片段 */
    function flushPass() {
        if (!state.linePrefix) return '';
        const marker = matchLineSource(state.linePrefix, compiled);
        const buffered = state.linePrefix;
        state.linePrefix = '';
        if (marker) {
            record(marker, buffered.length, 'line');
            return '';
        }
        return buffered;
    }

    return {
        /**
         * 处理一块增量
         * @param {string} delta
         * @returns {string} 可下发的文本(可能为空串)
         */
        filter(delta) {
            const text = typeof delta === 'string' ? delta : '';
            if (!text) return '';

            if (state.mode === 'blocked') {
                state.removedChars += text.length;
                return '';
            }

            if (state.mode === 'start') {
                state.hold += text;
                const decision = decideStart(state.hold);
                if (decision === 'hold') return '';
                if (decision === 'blocked') {
                    const marker = matchLineSource(state.hold, compiled) || 'unknown';
                    state.mode = 'blocked';
                    state.blocked = true;
                    record(marker, state.hold.length, 'start');
                    state.hold = '';
                    return '';
                }
                state.mode = 'pass';
                const buffered = state.hold;
                state.hold = '';
                /* 首行已确认不是回显: 按正常透传处理(首行可能还带后续行) */
                return processPass(buffered);
            }

            return processPass(text);
        },

        /**
         * 冲刷缓冲(流结束时必须调用, 否则短回复可能被吞)
         * @returns {string}
         */
        flush() {
            if (state.mode === 'blocked') return '';
            let output = '';
            if (state.mode === 'start') {
                if (!state.hold) return flushPass();
                const decision = decideStart(state.hold);
                if (decision === 'blocked') {
                    const marker = matchLineSource(state.hold, compiled) || 'unknown';
                    state.mode = 'blocked';
                    state.blocked = true;
                    record(marker, state.hold.length, 'start');
                    state.hold = '';
                    return '';
                }
                state.mode = 'pass';
                const buffered = state.hold;
                state.hold = '';
                output = processPass(buffered);
            }
            /* pass 阶段残留的行首片段: 再次确认不是标记后放行 */
            return output + flushPass();
        },

        /** 过滤统计(裁剪字符数 / 是否整段丢弃 / 命中的标记) */
        stats() {
            return {
                removedChars: state.removedChars,
                blocked: state.blocked,
                hits: [...state.hits]
            };
        }
    };
}
