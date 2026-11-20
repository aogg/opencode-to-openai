# opencode-to-openai Docker 镜像

基于 [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai) 构建的 Docker 镜像。

`opencode-to-openai` 是一个轻量级网关,把 [OpenCode](https://opencode.ai) CLI 转成标准的 OpenAI 兼容 REST API。通过它,可以在 Cursor、Claude Code 等任何支持 OpenAI 格式的 AI 客户端里,直接调用 OpenCode 提供的免费模型(如 Kimi k2.5、GLM 4.7、MiniMax m2.1)。

镜像内已自带 Node.js 22、上游项目源码和 OpenCode CLI(npm 包 `opencode-ai`),开箱即用;无需宿主机安装任何东西。

## adockero/opencode-to-openai:latest 镜像标签

- `adockero/opencode-to-openai:latest` - OpenCode 转 OpenAI 兼容 API 网关

### 快速开始

#### 基本使用

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name opencode-to-openai \
  --privileged \
  -p 8083:8083 \
  adockero/opencode-to-openai
```

服务地址:`http://your-ip:8083`

#### opencode 认证(重要)

容器内的 OpenCode CLI 需要先认证才能调用模型,二选一:

方式 1:进容器登录一次(按提示选择模型提供商并完成授权):

```bash
docker exec -it opencode-to-openai opencode auth login
```

方式 2:直接挂载宿主机已登录过的 opencode 凭据目录(`~` 为宿主机当前用户的 home,容器内以 root 运行):

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name opencode-to-openai \
  --privileged \
  -p 8083:8083 \
  -v ~/.local/share/opencode:/root/.local/share/opencode \
  adockero/opencode-to-openai
```

### 接口自检

健康检查:

```bash
curl http://127.0.0.1:8083/health
```

模型列表(配置了 `API_KEY` 时加 `-H "Authorization: Bearer <YOUR_API_KEY>"`):

```bash
curl http://127.0.0.1:8083/v1/models
```

对话补全(非流式示例):

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/kimi-k2.5-free","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

### 配置说明

配置不再构建期固化:容器**首次启动**(容器内无 `/app/config.json`)时,由入口脚本 `docker-entrypoint.sh` 按 `docker run -e` 环境变量生成 `/app/config.json`;之后每次启动直接沿用已有的 config.json。支持的变量与默认值如下:

| 环境变量 | 默认值 | 说明 |
|---------|-----------|------|
| `PORT` | `8083` | 网关监听端口 |
| `API_KEY` | 空(不鉴权) | 网关鉴权 key,生产环境建议必填 |
| `BIND_HOST` | `0.0.0.0` | 容器内必须监听 0.0.0.0,端口映射才能通(上游默认 127.0.0.1,入口脚本已改为 0.0.0.0) |
| `DISABLE_TOOLS` | `true` | 禁用 opencode 工具调用,避免模型在容器内执行命令/改文件 |
| `OPENCODE_PATH` | 空(自动探测) | opencode 可执行文件路径;留空时按 PATH 查找(npm 全局安装在 `/usr/local/bin/opencode`),程序还会自动探测 `~/.opencode/bin`、npm/pnpm 全局目录 |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` | 网关内部自动拉起的 opencode 后端服务地址,一般不用改 |
| `OPENCODE_BIND_HOST` | `0.0.0.0` | opencode 后端(4097)监听地址,容器内默认 `0.0.0.0`;程序内置默认 `127.0.0.1`(非容器场景行为不变),详见下方「4097 后端端口对外访问」 |
| `LOG_LEVEL` | `info` | 日志等级,可选 `error`/`warn`/`info`/`debug`(不区分大小写,非法值回退 `info` 并告警)。**特例:不走 config.json,由 node 进程直读环境变量,env 优先于 config.json 里的 `LOG_LEVEL` 字段**,详见下方「日志等级与请求日志」 |
| `OPENCODE_AUTO_APPROVE` | `true` | 自动批准 opencode 权限请求(`external_directory`/`bash`/`edit` 等不再挂起)。实现:给 opencode 注入 `OPENCODE_CONFIG_CONTENT` 的 `permission=allow` 规则 + 订阅 `permission.updated` 事件自动回复 `once`(留审计日志)。设 `false` 时权限请求会一直等到 `REQUEST_TIMEOUT_MS` 超时,详见下方「复杂任务、权限自动批准与工作目录」 |
| `OPENCODE_WORKDIR` | 空(jail 空目录) | opencode 干活的工作目录,作为 `session.create`/`prompt` 的 `query.directory`,后端 cwd 也切到该目录。复杂项目必须改成真实项目路径(容器内路径,如 `/code/www/my/github/xxx`);留空沿用原有隔离空目录 |
| `OPENCODE_STREAM_TOOLS` | `false` | 流式响应里额外把工具进度作为 SSE 注释行输出(`: tool bash running - ls -la`),默认关闭;注释行不影响 OpenAI 客户端解析,主要给抓包/调试看 |
| `OPENCODE_LOG_TAIL` | `false` | tail opencode 日志文件,新行以 debug 级转发到网关日志(默认路径 `~/.local/share/opencode/log/opencode.log`) |
| `OPENCODE_LOG_FILE` | 空(自动探测) | 配合 `OPENCODE_LOG_TAIL`,显式指定要 tail 的 opencode 日志文件路径 |
| `OPENCODE_PRINT_LOGS` | `false` | 给 `opencode serve` 加 `--print-logs`(并带 `--log-level DEBUG/INFO`,与网关日志等级联动),opencode 自己的日志直接并进容器日志 |
| `SYSTEM_PROMPT_PATTERNS` | 内置 dsh 标记 | 把命中规则的 **role=user** 消息内容提升到 `prompt.body.system`(不再拼进 user parts),解决"模型先复述系统提示词"。支持 JSON 数组或分号/换行/逗号分隔的正则;设 `none`/`off`/`[]` 关闭提升;非法正则告警并跳过 |
| `REQUEST_TIMEOUT_MS` | `300000` | 单次请求总超时(毫秒),超时返回 504,日志带"卡在哪一阶段" |
| `OPENCODE_EVENT_IDLE_TIMEOUT_MS` | `60000` | 事件流空闲超时(毫秒),文本增量/工具活动都会重置;超时后回退轮询兜底 |
| `OPENCODE_SSE_HEARTBEAT_MS` | `15000` | 流式期间 SSE 注释心跳间隔(`: ping`),避免长任务被客户端/中间层当空闲断开 |

示例(开启鉴权):

```sh
docker run -d --restart=always --network common-all --name opencode-to-openai --privileged -p 8083:8083 \
  -e PORT=8083 -e API_KEY=your-key -e DISABLE_TOOLS=true \
  adockero/opencode-to-openai
```

配置生效规则:

- `-e` 只在**首次启动**生成 config.json 时读取;`/app/config.json` 已存在时直接使用、**不被 `-e` 覆盖**(如 `-v` 挂载持久化的配置,优先于 `-e`)
- **特例:`LOG_LEVEL` 不写入 config.json**,由 node 进程直读环境变量,`docker run -e LOG_LEVEL=...` 每次启动都生效(优先级 env > config.json 的 `LOG_LEVEL` 字段 > 默认 `info`)
- 想用新的 `-e` 重新生成:删掉挂载的 config.json 文件(或去掉 `-v` 挂载)后重建容器即可
- 程序运行时读取优先级为 **环境变量 > config.json > 程序内置默认**(`index.js` 逐键合并,`PORT`/`OPENCODE_DISABLE_TOOLS` 等都是 env 优先),所以想临时改某一项直接加 `-e` 覆盖即可,不必删 config.json
- 新增键(`OPENCODE_AUTO_APPROVE`/`OPENCODE_WORKDIR`/`OPENCODE_STREAM_TOOLS`/`OPENCODE_LOG_TAIL`/`OPENCODE_LOG_FILE`/`OPENCODE_PRINT_LOGS`/`SYSTEM_PROMPT_PATTERNS`/`REQUEST_TIMEOUT_MS`/`OPENCODE_EVENT_IDLE_TIMEOUT_MS`/`OPENCODE_SSE_HEARTBEAT_MS`)同样是 **env > config.json > 内置默认**,`-e OPENCODE_AUTO_APPROVE=false` 对已存在 config.json 的容器也生效;`LOG_LEVEL` 见下节优先级

### 日志等级与请求日志

所有日志走 stdout/stderr(`docker logs` 可见),统一带 `[gateway]` 前缀,格式:`[gateway] <ISO时间> [LEVEL] 消息 {"detail":"json"}`。`error`/`warn` 走 stderr,`info`/`debug` 走 stdout。

用 `docker run -e LOG_LEVEL=<等级>` 控制(不区分大小写;非法值回退 `info` 并输出告警;镜像内置默认 `info`):

```bash
docker run -d --restart=always --name opencode-to-openai -p 8083:8083 -e LOG_LEVEL=debug adockero/opencode-to-openai
```

各等级输出内容:

| 等级 | 输出内容 |
|------|---------|
| `error` | 上游(opencode serve,4097)请求失败/错误(error 级恒输出):请求 id、**卡在哪一阶段**(`phase`:backend/session/prompt/collect/poll)、已耗时、状态码、`retry-after`、错误体摘要;权限自动批准失败、assistant error 事件也在这级 |
| `warn` | 非法日志等级回退告警、可自动恢复的异常、**请求超时(带 phase/耗时)**、opencode `session.status=retry`(429/overloaded,带 attempt 与 retry-after)、`OPENCODE_AUTO_APPROVE=false` 时等待人工的权限请求 |
| `info`(默认) | 启动信息(生效等级+来源、运行参数、系统提示词规则数) + **请求阶段进度**:`Request received`(reqId/model/stream/messages 数/最后一条用户消息摘要/是否带 system/system 字符数/被提升的系统注入条数)、排队等待、后端就绪耗时、session 创建、prompt 发送、**首个增量**,以及 `Request completed`(content/reasoning 字符数、总耗时、工具调用数、权限次数);**opencode 工具执行摘要**:`tool running/completed/failed`(工具名、输入摘要、结果/错误摘要、耗时);请求结束仍有一行 `POST /v1/chat/completions -> 200 xxxms [reqId]` 摘要;非 `/v1/` 路径(如 `/health`)只记 debug |
| `debug` | 额外输出:完整入站请求体(敏感头已脱敏)、**最终 upstream payload 摘要**(system 长度+预览、parts 数量+每条长度/预览、tools 开关)、opencode 事件流细节(事件类型、step、tool 状态变化、permission replied、session.status)、**上游响应全文**(流式累计文本+reasoning、非流式完整 JSON)、轮询/兜底细节、`OPENCODE_LOG_TAIL` 转发的 opencode 日志行 |

`docker logs` 各等级输出示例:

```text
# info(默认): 启动信息 + 每请求阶段日志 + opencode 工具/权限摘要
[gateway] 2026-11-20T07:00:15.000Z [INFO] Log level: info (source: env LOG_LEVEL)
[gateway] 2026-11-20T07:00:15.010Z [INFO] [Proxy] Runtime options {"workdir":"(jail empty workspace)","autoApprovePermissions":true,"streamToolProgress":false,"printOpencodeLogs":false,"tailOpencodeLog":false,"requestTimeoutMs":300000,"eventIdleTimeoutMs":60000,"sseHeartbeatMs":15000}
[gateway] 2026-11-20T07:00:15.401Z [INFO] [Proxy] Request received {"reqId":"gw-mwo...","model":"opencode/kimi-k2.5-free","stream":true,"messages":3,"lastUser":"请回答问题","hasSystem":true,"systemChars":31,"promotedSystemMessages":1,"promotedChars":21,"parts":1}
[gateway] 2026-11-20T07:00:15.405Z [INFO] [Proxy] Backend ready {"reqId":"gw-mwo...","ms":1,"spawned":false,"workdir":"/code/www/my/github/demo"}
[gateway] 2026-11-20T07:00:15.412Z [INFO] [Proxy] Session created {"reqId":"gw-mwo...","sessionId":"ses_1","ms":6,"workdir":"/code/www/my/github/demo"}
[gateway] 2026-11-20T07:00:15.542Z [INFO] [Proxy] First delta received {"reqId":"gw-mwo...","sessionId":"ses_1","ms":129,"type":"reasoning"}
[gateway] 2026-11-20T07:00:15.602Z [INFO] [opencode] tool running: bash {"reqId":"gw-mwo...","tool":"bash","status":"running","input":"ls -la /code/www/my/github/demo"}
[gateway] 2026-11-20T07:00:15.662Z [INFO] [opencode] permission requested {"reqId":"gw-mwo...","permissionId":"per_1","type":"external_directory","title":"Access external directory","pattern":"/code/www/*"}
[gateway] 2026-11-20T07:00:15.666Z [INFO] [opencode] permission auto-approved {"reqId":"gw-mwo...","permissionId":"per_1","type":"external_directory","response":"once"}
[gateway] 2026-11-20T07:00:15.688Z [INFO] [opencode] tool completed: bash {"reqId":"gw-mwo...","tool":"bash","status":"completed","output":"total 4","ms":30}
[gateway] 2026-11-20T07:00:15.808Z [INFO] [Proxy] Prompt sent {"reqId":"gw-mwo...","sessionId":"ses_1","ms":394,"parts":1,"systemChars":31}
[gateway] 2026-11-20T07:00:15.812Z [INFO] [Proxy] Request completed {"reqId":"gw-mwo...","stream":true,"chunks":3,"contentChars":5,"reasoningChars":4,"totalMs":411,"toolCalls":1,"permissions":1,"autoApproved":1,"finishReason":"stop"}
[gateway] 2026-11-20T07:00:15.813Z [INFO] POST /v1/chat/completions -> 200 422ms [gw-mwo...] model=opencode/kimi-k2.5-free stream=true

# debug: 追加完整请求体 / payload 摘要 / 事件流细节 / 上游响应全文 / opencode 日志 tail
[gateway] 2026-11-20T07:00:15.010Z [DEBUG] Incoming OpenAI request {"reqId":"gw-mwo...","headers":{"authorization":"Bear***c9Zw","content-type":"application/json"},"body":{"model":"opencode/kimi-k2.5-free","messages":["..."],"stream":true}}
[gateway] 2026-11-20T07:00:15.032Z [DEBUG] Upstream payload (final request body to opencode serve) {"reqId":"gw-mwo...","systemChars":31,"systemPreview":"你是助手...# 角色注入...","partsCount":1,"parts":[{"index":0,"type":"text","chars":11,"preview":"USER: 请回答问题"}],"tools":null}
[gateway] 2026-11-20T07:00:15.811Z [DEBUG] [opencode] event stream summary {"reqId":"gw-mwo...","reason":"message-finished","events":6,"deltaChars":9,"toolCalls":1,"permissions":1}
[gateway] 2026-11-20T07:00:15.812Z [DEBUG] [Proxy] Upstream response (stream full text) {"reqId":"gw-mwo...","content":"你好，答案","reasoning":"我在思考"}
[gateway] 2026-11-20T07:00:15.900Z [DEBUG] [opencode][log] timestamp=... level=INFO message=tool bash ...

# warn: 超时 / 上游限流重试 / 非法日志等级
[gateway] 2026-11-20T07:00:36.965Z [WARN] [Proxy] Request timed out (stuck phase) {"reqId":"gw-...","sessionId":"ses_2","phase":"prompt","elapsedMs":1214,"timeoutMs":1200}
[gateway] 2026-11-20T07:00:40.000Z [WARN] [opencode] session retry (upstream throttling/overload) {"reqId":"gw-...","attempt":1,"rateLimited":true,"retryAfter":"3s","nextInMs":3000}
[gateway] 2026-11-20T07:00:41.000Z [WARN] Invalid log level 'verbose' from CLI --log-level, ignored (valid values: error/warn/info/debug)

# error: 上游失败必输出(带 phase/状态码/retry-after/错误体摘要)
[gateway] 2026-11-20T07:01:00.000Z [ERROR] [Proxy] API Error (upstream call failed) {"reqId":"gw-...","phase":"session","elapsedMs":7,"message":"Create OpenCode session failed: ...","status":500,"retryAfter":null,"bodySummary":"..."}
```

### 日志等级怎么设置(CLI / env / config.json)

```bash
# 直接跑 node
node index.js --log-level debug
node index.js --log-level=debug

# docker: 覆盖镜像 CMD, entrypoint 会原样 exec 这些参数
docker run -d --restart=always --network common-all --name opencode-to-openai -p 8083:8083 \
  adockero/opencode-to-openai node index.js --log-level debug
```

优先级(高 -> 低):

1. CLI `--log-level <等级>`
2. 环境变量 `LOG_LEVEL`
3. `config.json` 的 `LOG_LEVEL`
4. 旧 `DEBUG` 开关(`DEBUG=true` / `OPENCODE_PROXY_DEBUG=1`)
5. 默认 `info`

任一层给非法值时输出 `warn` 告警并继续尝试下一优先级;全部无效回退 `info`。启动日志会打印 `Log level: <等级> (source: CLI --log-level|env LOG_LEVEL|config.json LOG_LEVEL|legacy DEBUG flag|default)`。

### 复杂任务、权限自动批准与工作目录

以前复杂任务跑不起来的原因(源码里已按下面方式修掉):

- opencode 遇到 `permission=external_directory ... action=ask` 会等人批准,网关没有人批准,请求一直挂到 `REQUEST_TIMEOUT_MS`(容器日志里的 `Request timeout after 300000ms`);
- 上游 429 overloaded 限流时没有重试提示,只看得到超时;
- 网关只处理 text/reasoning part,工具在干什么完全看不到;每个请求新建 session、把全部 messages 拼成一条 user prompt(后面用 `OPENCODE_WORKDIR` 让它在真实项目目录里干活)。

现在的工作方式:

- **自动批准权限(默认开)**,两层实现:
  - 配置层:拉起 opencode 后端时注入 `OPENCODE_CONFIG_CONTENT`,把 `edit`/`bash`/`webfetch`/`external_directory`/`doom_loop`/`read`/`glob`/`list`/`grep`/`task`/`question` 与 `*` 设为 `allow`;
  - 事件层:订阅 `permission.updated`,对本次 session 的权限请求自动 `POST /session/{id}/permissions/{permissionID}` 回复 `once`,并输出 info 审计日志;回复失败会打 error(提示请求可能挂到超时)。
  - 注意:**opencode 1.19.5 的 `opencode serve` 没有 `--auto`**(实测传了会打印 help 并 exit 1),所以这里没有用 `--auto`,而是上述两层。`opencode run --auto` 另说,与网关无关。
  - 风险提示:自动批准等于允许模型在容器内执行 bash/改文件。需要收紧时设 `OPENCODE_AUTO_APPROVE=false`(此时权限请求会等到超时),或把 `OPENCODE_WORKDIR` 指到受控目录,并用容器边界隔离。
- **工作目录**:`-e OPENCODE_WORKDIR=/code/www/my/github/demo`。`session.create` 与 `prompt` 都带 `query.directory`,后端进程 cwd 也切到该目录;不配置时仍是原来的 jail 空目录(向后兼容)。
- **工具执行可见**:从 SSE 的 ToolPart 提取工具名/状态/输入摘要/结果或错误摘要,info 级输出 `[opencode] tool running/completed/failed`,**不写进模型正文**;想在 SSE 响应里也看到进度,设 `OPENCODE_STREAM_TOOLS=true`(输出 `: tool ...` 注释行,OpenAI 客户端会忽略注释,不影响解析)。
- **超时/心跳/重试**:`REQUEST_TIMEOUT_MS` 控总超时;流式期间每 `OPENCODE_SSE_HEARTBEAT_MS` 发一次 `: ping` 注释心跳;事件流空闲超时 `OPENCODE_EVENT_IDLE_TIMEOUT_MS`(默认 60s,文本增量与工具活动都会重置);`session.status=retry` 输出 warn 并带 `retryAfter` 摘要;首包/空闲超时后回退轮询兜底。

### opencode 执行情况怎么看

| 手段 | 配置 | 输出 |
|------|------|------|
| 工具/权限摘要(推荐) | 默认开 | info: `[opencode] tool running/completed/failed`、`[opencode] permission requested/auto-approved`;每个请求的阶段日志能看出卡在哪一步 |
| 事件流细节 | `LOG_LEVEL=debug` | 事件类型、step、tool 状态变化、`permission.replied`、`session.status`、`[opencode] event stream summary` |
| tail opencode 日志文件 | `-e OPENCODE_LOG_TAIL=true`(+ 可选 `-e OPENCODE_LOG_FILE=/path/to/opencode.log`) | 新行以 debug 级转发,前缀 `[opencode][log]`;路径默认自动探测 `~/.local/share/opencode/log/opencode.log` |
| opencode 日志直接并进容器日志 | `-e OPENCODE_PRINT_LOGS=true` | `opencode serve --print-logs --log-level DEBUG/INFO`(与网关等级联动),stdio 已是 inherit |

容器里实时看:`docker logs -f opencode-to-openai`。

### 系统提示词分离(避免模型复述系统提示词)

背景:dsh 等客户端会把"角色注入 / 项目系统提示词 / system-reminder / 技能列表"当作 **role=user** 的消息发给 OpenAI 兼容接口,旧逻辑把它们和真实用户消息一起拼成 `USER: ...` parts,模型会先复述这些系统提示词,体验很差。

现在的行为:

- `role=system` 的消息 → 仍进 `prompt.body.system`;
- 命中 `SYSTEM_PROMPT_PATTERNS` 的 **user** 消息 → 内容提升到 `prompt.body.system`,不再出现在 parts;system 内容去重;
- 若所有 user 消息都被提升(parts 为空会被上游 400):保留最后一条放回 parts,保证请求仍能进行;
- debug 日志 `[Proxy] System prompt messages promoted out of user parts` 记录提升条数与字符数;info 的 `Request received` 也带 `promotedSystemMessages` / `promotedChars`;
- 默认标记:`^# 角色注入`、`^<system-reminder>`、`^【会话自动搬移已开启】`、`^Current runtime context`、`^# 项目系统提示词`、`^Time sampled while preparing turn`;
- 自定义:`-e SYSTEM_PROMPT_PATTERNS='^# 角色注入;^<custom-tag>'`(分号/换行分隔,也支持 JSON 数组;正则里含逗号时请用分号分隔);关闭:`none`/`off`/`false`/`0`/`[]`;
- 未改变:SSE 差量化、轮询兜底、`DISABLE_TOOLS` 的 tool filter 逻辑都保持原样。

### 4097 后端端口对外访问

网关(8083)启动时会自动在容器内拉起 opencode serve 后端(4097)。后端的监听地址由 `OPENCODE_BIND_HOST` 控制:容器内 `-e` 生成配置时默认 `0.0.0.0`,程序内置默认 `127.0.0.1`(仅容器内回环可用,对外不可达)。

要在容器外直接访问 4097,`docker run` 增加端口映射 `-p 4097:4097`(需要时可用 `-e OPENCODE_BIND_HOST=0.0.0.0` 显式指定,容器内默认已是 `0.0.0.0`):

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name opencode-to-openai \
  --privileged \
  -p 8083:8083 \
  -p 4097:4097 \
  adockero/opencode-to-openai
```

说明:

- `OPENCODE_BIND_HOST` 只控制 opencode 后端(4097)的监听地址;网关(8083)自己的监听地址由 `BIND_HOST` 控制,两者互不影响
- 网关自身始终按 `OPENCODE_SERVER_URL`(默认 `http://127.0.0.1:4097`)访问后端,`OPENCODE_BIND_HOST=0.0.0.0` 不影响网关与后端的容器内通信(0.0.0.0 覆盖回环地址)
- 要改回仅容器内可用,设 `OPENCODE_BIND_HOST=127.0.0.1`(即程序内置默认)
- 坑点:`-e` 只在容器**首次启动**生成 `/app/config.json` 时读取;容器内已有 `/app/config.json`(如 `-v` 挂载)时 `-e` 不生效,需直接改挂载的 config.json(把 `OPENCODE_BIND_HOST` 改为 `0.0.0.0`),或删掉该文件后重建容器

### 已知问题与兼容修复

以下两个 opencode 1.19.5 兼容问题,已直接修复在源码仓库 [aogg/opencode-to-openai](https://github.com/aogg/opencode-to-openai)(`dxxzst/opencode-to-openai` 的 fork)的 `src/proxy.js` 中——不再是镜像内补丁,镜像直接从该仓库构建,Dockerfile 内无任何运行时打补丁步骤:

- **修复一(工具挂起)**:opencode>=1.19 + zen 免费模型(如 `opencode/deepseek-v4.1-flash-free`)下,`DISABLE_TOOLS=true`(镜像内置默认)会把 opencode 全部工具禁用,而 tools 里只要禁用 `read` 或 `glob` 任意一个,prompt 请求就会永久挂起无响应,表现为网关不返回对话内容。修复做法:`read`、`glob` 两个只读工具保持启用,其余工具(bash/edit/write/task/webfetch/question/grep/skill 等)仍全部禁用;`read`/`glob` 只读、无写入/执行能力,且源码里还有 `stripFunctionCalls` 输出过滤 + `TOOL_GUARD_MESSAGE` 系统提示作为第二道防线。
- **修复三(权限挂起 / 复杂任务)** version 1.19.5 下 `permission=external_directory` 之类的 ask 没人批准会一直挂到超时;同时 `opencode serve` 不支持 `--auto`。修复做法:自动批准用 `OPENCODE_CONFIG_CONTENT` 的 `permission=allow` + `permission.updated` 事件自动回复 `once` 两层实现(见上方「复杂任务、权限自动批准与工作目录」),并用 `OPENCODE_WORKDIR` 让 opencode 在真实项目目录里干活。
- **修复二(流式 SSE 兼容)**:opencode>=1.19 的 SSE `message.part.updated` 事件没有 `properties.delta` 字段,`part.text` 是该 part 当前**全量文本**,修复前按 `const { part, delta } = event.properties` 取增量永远是 undefined,导致流式响应零内容、只剩 finish 块;且 assistant 很快结束时 `message.updated(finish=stop)` 会先于 4s 首包定时器到达,事件收集带着空内容提前 resolve,原有 noData/idleTimeout 兜底轮询都覆盖不到这条路径(非流式路径不受影响)。修复做法:事件自带 `properties.delta` 时优先用(兼容老版本),缺失时按已累积内容对 `part.text` 差量化出增量(`startsWith` 判断后 `slice`);流式一个字都没发过时,兜底轮询一次 `pollForAssistantResponse` 取完整回复再下发(经 `stripFunctionCalls` 同款过滤),轮询也无内容则不发任何 delta。

## 相关链接

- [opencode-to-openai GitHub](https://github.com/dxxzst/opencode-to-openai)
- [OpenCode 官网](https://opencode.ai)
