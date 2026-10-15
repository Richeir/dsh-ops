# dsh-ops 端到端 Token Benchmark —— 设计与实施计划

> 状态：**方案已定稿，待实现**（实现与实测在 Windows x64 机器上进行）。
> 主对比场景：**无插件基线（stock dsh-base 工具面） vs 装有 dsh-ops 的候选**。
> 同一套 harness 也支持"旧版 dsh-ops vs 新版 dsh-ops"（换 profile 里安装的插件版本即可）。
>
> 本文档自包含：第 2 节记录了在 macOS 上对 DSH `0.2.0-rc.2` 实地调研得到的全部接口事实，
> 实现时不需要重新逆向。

---

## 1. 目标与非目标

**目标**：回答"某个修改（prompt 段、工具描述、schema、工具行为、插件整体）之后，
真实模型跑真实任务，token 消耗降了没有？降了多少？任务还能不能完成？"

- 端到端测量：以 provider 上报的 usage 为准（与 TUI `/tokens` 同源），不是静态字节估算。
- 可重复：任务语料确定性生成、每 run 全新会话与全新工作区、重复 N 次取中位数。
- 可审计：原始 NDJSON 事件流全部落盘存档。
- 有门禁：候选 token 回归或任务通过率下降 → 对比命令非零退出。

**非目标**：

- 不替代 `scripts/measure-schemas.mjs`（静态 schema 字节测量保留，二者互补）。
- 不产出可对外引用的"官方节省百分比"——报告永远标注自测口径（对齐 `PROVENANCE.md`：
  "No benchmark is inferred"，不得做无实据声明）。
- 不测 TUI/Web 交互层；只测 headless 单发会话。

## 2. 调研结论（DSH 0.2.0-rc.2 接口事实）

实现所依赖的全部机制已在 macOS 上核实。Windows 上包路径相同（npm 全局安装的
`@deepseek-ai/dsh/node_modules/@deepseek-ai/...`）。

### 2.1 headless 单发模式

- 调用：`dsh --profile headless --json "<task>"`
  （源码：`dsh-headless/lib/startup.js`，commander 定义 `[task...]` 位置参数 +
  `--json` + `--session-id`；多词 task 用空格拼接；`-` 读 stdin 且必须是唯一参数）。
- 行为（`dsh-headless/lib/index.js`）：新建一个 Agent（或按 `--session-id` 收养既有会话，
  benchmark 不用收养），投递任务，跑到 quiescence，flush 会话，
  **退出码 0 当且仅当 `turn/end.reason.kind === "completed"`**，否则 1；
  `--json` 时 stdout 输出 NDJSON 事件流，stderr 输出诊断。
- headless profile = `dsh-base` + `dsh-headless` 两个 bundle，无 Host/HTTP/浏览器层
  （`dsh-app-boot/lib/index.js` 的 `PROFILE_TEMPLATES`）。
- headless **不组合 agent preset**（收养带 preset 的会话会直接报错；新建会话无 preset）。

### 2.2 `--json` NDJSON 事件格式（`dsh-headless/lib/json-stream-*.js`）

每行一个 JSON 对象，字符串按 8KB、整行按 32KB 截断（截断时带 `"truncated":true`；
`final` 事件不截断）。事件类型：

| 事件 | 形状 | 说明 |
| --- | --- | --- |
| `session` | `{type,sessionId,cwd}` | 流首事件 |
| `status/turn_start` | `{type:"status",phase:"turn_start",turn}` | |
| `status/step_start` | `{type:"status",phase:"step_start",turn,step}` | |
| `thinking` | `{type:"thinking",text}` | 提交后的 reasoning 块 |
| `text` | `{type:"text",text}` | 提交后的正文块 |
| `tool_call` | `{type:"tool_call",callId,tool,input}` | `input` 为解析后的对象；解析失败保留原始字符串 |
| `tool_result` | `{type:"tool_result",callId,status:"completed"\|"error",result}` | `result` 是模型可见文本块的拼接 |
| `status/step_end` | `{type:"status",phase:"step_end",turn,step,usage?}` | **usage 见下** |
| `status/turn_end` | `{type:"status",phase:"turn_end",turn,reason}` | `reason.kind` 为 `completed`/`error` 等 |
| `final` | `{type:"final",text}` | 最终回答全文（不截断） |
| `error` | `{type:"error",message}` | 启动/运行失败 |

**usage 字段**（`step_end`，provider 上报、DSH 归一化）：

```json
{ "inputTokens": 0, "outputTokens": 0,
  "totalTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": 0 }
```

- 四桶互斥模型：`input`（未缓存输入）/`output`/`cacheRead`/`cacheWrite`；
  `totalTokens`、`reasoningTokens` 为可选（provider 报了才有）。
- 一个 step 的 usage 是其全部 attempt（含被重试丢弃的）的累加；
  **任何一个 attempt 没报 usage，整个 step 的 usage 字段直接省略**（宁缺毋假）。
  → 聚合器必须统计 `stepsWithUsage/steps`，缺失时明确报"usage 不完整"，绝不拿部分和冒充完整。

### 2.3 profile / 模型路由 / 插件

- 自定义 profile：`dsh <name> --from-default-profile headless` 从 headless 模板创建并启动；
  配合 `--dump-config`（打印组合树后退出）可**只初始化不跑任务**：
  `dsh bench-base --from-default-profile headless --dump-config >NUL`
  （实现后第一件事先实测确认这条命令确实只初始化；兜底方案：跑一条 smoke 任务）。
- 模型路由在 profile 的 patch 层 `~/.dsh/profiles/<name>/cordis.patch.yml`：
  - `llm-pi-ai` 行 `config.providers.<路由名>`：`{baseURL, apiKeyEnv, api:"openai-completions", models:[{id, contextWindow?, maxTokens?, reasoningEfforts?}], retryPolicy?}`
    （dsh-base 默认挂载 `llm-pi-ai`，零路由休眠，配置即注册）。
  - `agent-default-model` 行 `config:{provider, model}`（两项均 required；
    headless 用 `agentDefaultModel.currentSelection()` 决定路由）。
  - API key：`apiKeyEnv` 指定的环境变量名，凭据可放环境或 `~/.dsh/.credentials.yaml`。
- 插件安装走官方 profile 管理器：`dsh plugin --profile <name> add <spec>`
  （pnpm 参数透传：版本号 / 本地路径 / tarball 均可；dsh-ops 自己的 installer
  `lib/profile-install.js` 就是 `dsh plugin --profile <t> add dsh-ops@<version>`）。
  卸载：`dsh plugin --profile <name> remove dsh-ops`。
- dsh-ops 的 `package.json` 声明 `os:["win32"], cpu:["x64"]`，且 payload 只有
  win32 包 → **插件 variant 只能在 Windows x64 上装/跑**；harness 代码本身跨平台。

### 2.4 权限与沙箱（任务设计的硬约束）

- headless 无交互应答器：需要审批的操作 **fail closed**（直接拒绝）。
- 默认沙箱 workspace-write：任务的一切写操作必须留在会话工作目录内 → fixture、
  产出文件、`node test.js` 全部在工作区内，天然满足。
- 不要在任务里设计需要 network / 越权写的步骤。

### 2.5 会话持久化副作用

每个 headless run 会在 `$DSH_HOME/sessions/<工作区slug>/<sessionId>/session.v4.jsonl.zstd`
留下持久化会话。benchmark 用临时工作区 → 会积累一次性会话目录。README 要给出清理提示
（按 mtime 删除 `~/.dsh/sessions/` 下对应临时工作区 slug 的目录），harness 不自动删。

### 2.6 自托管服务器的 usage 上报前提（实测第一关）

`step_end.usage` 依赖 provider 在**流式响应**里回报 usage。OpenAI 兼容服务器需要支持
`stream_options: {"include_usage": true}`（vLLM / sglang / llama.cpp 各有开关或版本要求）。
若服务器不报：事件流里 `step_end` 无 usage → harness 仍能数步数/工具调用，但**拒绝给出
token 结论**。实施步骤里必须先跑 smoke 任务确认 usage 存在，再开始正式测量。

## 3. 架构与目录

```
bench/
  PLAN.md              # 本文档
  README.md            # 方法论 + Windows 环境搭建 + 免责声明（实现时写）
  run.mjs              # 运行器 CLI
  compare.mjs          # 对比 CLI（报告 + 门禁）
  lib/
    tasks.mjs          # 任务语料加载与结构校验
    fixtures.mjs       # 确定性工作区生成器（seeded PRNG）+ 期望值导出
    verify.mjs         # 完成度机器校验（无 shell、跨平台）
    aggregate.mjs      # NDJSON 事件流 → 单次运行指标（纯函数，可单测）
    compare-core.mjs   # 两份 summary → 对比结构（纯函数，可单测）
  tasks/
    grep-sweep.task.json
    bulk-rename.task.json
    csv-sum.task.json
    fix-build.task.json
    log-stats.task.json
  runs/                # 运行输出，gitignore
    <UTC时间戳>-<label>/
      meta.json            # label、profile、dsh bin、平台、node 版本、尽力提取的 provider/model
      dump-config.txt      # dsh --profile <p> --dump-config 存档（公平性证据）
      summary.json         # 机器可读汇总（compare 的输入）
      report.md            # 单 run 简报（人读）
      results/
        <taskId>-r<n>.metrics.json
        <taskId>-r<n>.events.ndjson   # 原始事件存档
        <taskId>-r<n>.stderr.log
```

代码风格对齐仓库现状：ESM、零外部依赖、无分号、单引号、2 空格缩进、JSDoc 模块头。
Node 版本按 `engines`：`^22.19 || >=24`。

## 4. 数据格式

### 4.1 任务语料（`bench/tasks/*.task.json`）

```json
{
  "id": "csv-sum",
  "title": "Aggregate a large CSV without drowning the context",
  "prompt": "The file data.csv has the header id,region,amount. Compute the sum of the amount column over all rows whose region is exactly EU. Write only the resulting integer into answer.txt (no other characters).",
  "fixture": { "generator": "largeCsv", "params": { "seed": 7, "rows": 20000, "targetRegion": "EU" } },
  "verify": [ { "type": "fileEquals", "path": "answer.txt", "expect": "sum" } ],
  "timeoutMs": 900000
}
```

- `prompt` 用英文（省 token、避免 CJK 分词差异引入噪声），描述必须**精确且机器可校验**。
- `fixture.generator` ∈ fixtures.mjs 导出的生成器名；`params` 原样传入。
- `verify[].expect` 引用生成器导出的期望值键名；也可用字面量 `text`/`lines`/`count`。
- `timeoutMs` 缺省 900000（15 分钟）。

### 4.2 fixture 生成器契约（`bench/lib/fixtures.mjs`）

每个生成器 `(params) => { files, exports }`：

- `files`: `[{ path, content }]`，path 为 POSIX 相对路径，由 run.mjs 写入工作区；
- `exports`: 期望值字典（数字/字符串/字符串数组），供 verify 引用；
- **确定性**：内部用 mulberry32 seeded PRNG，同 seed 两次生成逐字节一致（单测覆盖）；
- 生成物不提交进 git（每次 run 现场生成，体积小、速度快）。

### 4.3 verify 检查类型（`bench/lib/verify.mjs`）

全部只用 `node:fs` + `node:child_process.spawn`（不经 shell，跨平台）：

| type | 参数 | 判定 |
| --- | --- | --- |
| `fileExists` | `path` | 存在 |
| `fileMissing` | `path` | 不存在 |
| `fileEquals` | `path`, `text`\|`expect` | 内容 trim 后全等 |
| `fileContains` | `path`, `text`\|`expect` | 包含子串 |
| `fileLines` | `path`, `lines`\|`expect` | trim 后非空行序列全等（有序） |
| `countFiles` | `dir`, `prefix?`, `suffix?`, `extension?`, `count`\|`expect` | 递归计数全等 |
| `command` | `command`, `args?`, `exitCode?=0`, `cwd?="."` | spawn 退出码全等；`command:"node"` 映射 `process.execPath` 保证确定性 |

单个检查失败不中断，全部跑完；结果 `{passed, checks:[{type,path?,passed,detail}]}`。
`detail` 只放短摘要（期望 vs 实际的前 200 字符），防止把大内容灌进报告。

### 4.4 单次运行指标（`<task>-r<n>.metrics.json`）

```json
{
  "format": "dsh-ops-bench-metrics-v1",
  "label": "cand-0.3.1", "profile": "bench-cand",
  "taskId": "csv-sum", "repeatIndex": 0,
  "startedAt": "ISO", "durationMs": 0,
  "exitCode": 0, "timedOut": false,
  "sessionId": "session-...", "turnEndReason": "completed",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
             "cacheWriteTokens": 0, "reasoningTokens": 0, "grandTotal": 0 },
  "usageReported": true, "steps": 0, "stepsWithUsage": 0, "turns": 0,
  "toolCalls": 0, "toolErrors": 0, "toolCallsByName": {},
  "textChars": 0, "thinkingChars": 0, "finalTextBytes": 0,
  "eventCount": 0, "malformedLines": 0,
  "verify": { "passed": false, "checks": [] },
  "eventsFile": "results/csv-sum-r0.events.ndjson"
}
```

- `grandTotal` = 四桶之和（input+output+cacheRead+cacheWrite）；
  `reasoningTokens` 单列展示，**不**计入 grandTotal（通常是 output 的子集）。
- `usageReported` = `steps > 0 && stepsWithUsage === steps`；false 时 usage 各字段仍写
  已知部分和，但 compare 拒绝据此下 token 结论。
- 可选桶（provider 没报的）按 0 计并在 `usage` 里省略对应键，聚合器记录哪些桶出现过。

### 4.5 `summary.json`

```json
{
  "format": "dsh-ops-bench-summary-v1",
  "label": "...", "profile": "...", "dshBin": "dsh",
  "model": { "provider": "...", "model": "...", "bestEffort": true },
  "platform": { "os": "win32", "arch": "x64", "node": "v22.x" },
  "startedAt": "ISO", "finishedAt": "ISO", "repeat": 3,
  "taskIds": ["..."], "results": [ "<4.4 的 metrics 数组>" ],
  "totals": { "grandTotal": 0, "steps": 0, "toolCalls": 0, "toolErrors": 0,
              "passed": 0, "failed": 0, "usageComplete": true }
}
```

`model` 来自对 `dump-config.txt` 的尽力正则提取（找 `agent-default-model` 段的
`provider:`/`model:`），提不到就 null + bestEffort 标记，不阻塞运行。

## 5. run.mjs 设计

```
node bench/run.mjs --label <label> --profile <dsh-profile>
                   [--task <id>]...        # 缺省全部任务
                   [--repeat N]            # 缺省 3
                   [--timeout ms]          # 覆盖任务级 timeoutMs
                   [--dsh <bin>]           # 缺省 "dsh"（PATH）
                   [--out <dir>]           # 缺省 bench/runs/<UTC>-<label>
                   [--keep]                # 保留临时工作区（默认跑完即删）
                   [--dry-run]             # 只生成 fixture + 对未开工工作区跑 verify（应全失败），不 spawn dsh
                   [--list]                # 列出任务后退出
```

流程（每个 任务 × 重复轮次 串行执行，避免自托管服务器并发干扰计时与配额）：

1. `mkdtemp` 临时工作区（`os.tmpdir()/dsh-ops-bench-<task>-r<n>-`）→ 写入 fixture files；
2. spawn `dsh --profile <p> --json "<prompt>"`，`cwd=工作区`，`env=process.env` 透传，
   `stdio: ['ignore','pipe','pipe']`；POSIX 用 `detached:true`（杀进程树用负 pid），
   win32 用 `windowsHide:true`；
3. stdout 走 `readline` 逐行：原样追加到 `events.ndjson` + 喂 aggregate；stderr 落 `stderr.log`；
4. 超时：win32 `taskkill /PID <pid> /T /F`，POSIX `process.kill(-pid,'SIGKILL')`；标记 `timedOut`；
5. 进程退出后在工作区执行 verify → metrics；
6. 清理工作区（除非 `--keep`）；控制台打一行进度：
   `[3/15] csv-sum r1: exit=0 steps=4 tokens=18,204 in/3,110 out verify=PASS 96s`；
7. 全部完成 → 写 `meta.json`、`summary.json`、`report.md`；任一 run `usageReported=false`
   → 控制台显著警告 + report.md 顶部警告（附 2.6 节的服务器排查指引）。

首次运行（每个 label 一次）先执行 `dsh --profile <p> --dump-config` 存档到 run 目录。

## 6. compare.mjs 设计

```
node bench/compare.mjs <base-label|dir> <cand-label|dir>
                       [--aggregate median|min]     # 缺省 median（并列展示 min）
                       [--tolerance-pct 2]          # 门禁容差，缺省 2
                       [--fail-on regression|pass-drop|both|none]   # 缺省 both
                       [--json <out.json>]
```

- label 解析：在 `bench/runs/` 下按后缀匹配，多个命中取最新；也接受完整目录路径。
- 对齐：按 `taskId` join；每任务把 N 次重复聚合成 median + min + passRate。
- `compare-core.mjs` 纯函数输出：

```json
{
  "tasks": [{ "id": "csv-sum",
    "base": { "grandTotalMedian": 0, "grandTotalMin": 0, "inputMedian": 0, "outputMedian": 0,
              "stepsMedian": 0, "toolCallsMedian": 0, "toolErrorsMedian": 0,
              "passRate": 1, "repeats": 3 },
    "cand": { "...": "同上" },
    "delta": { "grandTotalPct": -37.2, "stepsPct": -25.0, "toolCallsPct": -40.0 } }],
  "totals": { "baseGrandTotal": 0, "candGrandTotal": 0, "grandTotalPct": 0,
              "basePassRate": 0, "candPassRate": 0 },
  "warnings": ["model-mismatch", "usage-incomplete:base", "..."]
}
```

- Markdown 报告（stdout + 写入候选 run 目录 `comparison-<base>-vs-<cand>.md`）：

```
| task        | tokens base→cand (Δ%)      | steps | tool calls | tool errors | pass      |
|-------------|----------------------------|-------|------------|-------------|-----------|
| csv-sum     | 21,314 → 13,400 (-37.1%)   | 5→4   | 6→3        | 1→0         | 3/3→3/3   |
| ...         |                            |       |            |             |           |
| **TOTAL**   | 96,208 → 61,733 (-35.8%)   | 24→17 | 31→19      | 4→1         | 15/15→15/15 |
```

  token 列 = grandTotal（median），脚注展开四桶明细与 cache 命中差异。
- 门禁（`--fail-on`）：
  - `regression`：cand TOTAL grandTotal(median 之和) > base × (1 + tolerance/100) → exit 1；
  - `pass-drop`：任一任务或 TOTAL 的 cand passRate < base passRate → exit 1；
- 硬性警告（打印但不阻断）：两侧 model/provider 不一致；任一侧 usage 不完整
  （此时 token 列打印 `n/a`，门禁自动降级为仅 pass-drop）。

## 7. 首批 5 个任务规格

fixture 内容全部现场生成；期望值由生成器导出。目标平台 Windows（bash/宿主 shell 均可完成任务）。

### 7.1 grep-sweep —— 搜索扫描

- fixture `grepTree{seed:1, dirs:10, filesPerDir:30, linesPerFile:40, needle:"NEEDLE_X7Q", needleFiles:12}`：
  `src/dirNN/fileNNN.js`，共 300 个文件；needle 以 `const MARK = "NEEDLE_X7Q"` 形式恰好出现在
  12 个确定文件里；其余文件保证不含该子串。exports：`matches`（12 个 POSIX 相对路径，字典序）。
- prompt（要点）：找出所有包含精确 token `NEEDLE_X7Q` 的文件，把相对路径按字典序一行一个写入
  `matches.txt`，不要写入其他内容。
- verify：`fileLines matches.txt expect=matches`。
- 打点：搜索工具输出体积（300 文件树的 grep 结果会不会灌爆上下文）、来回步数。

### 7.2 bulk-rename —— 批量操作

- fixture `renameTree{seed:2, count:120}`：`data/TEMP_0001.dat … TEMP_0120.dat`，
  每个文件 5 行随机十六进制样式文本。exports：`count=120`。
- prompt：把 `data/` 下所有以 `TEMP_` 开头的文件改名为 `DATA_` 前缀（其余文件名不变），不改内容。
- verify：`countFiles{dir:"data",prefix:"DATA_",count:120}` + `countFiles{dir:"data",prefix:"TEMP_",count:0}`。
- 打点：批量 shell 循环 / 批处理工具 vs 120 次逐个工具调用。

### 7.3 csv-sum —— 大文件聚合

- fixture `largeCsv{seed:7, rows:20000, targetRegion:"EU", regions:["EU","US","APAC","LATAM"]}`：
  `data.csv`，表头 `id,region,amount`，amount 为 1..10000 整数。exports：`sum`（精确整数和）。
- prompt：对 `region` 恰为 `EU` 的行求 `amount` 总和，把整数结果（仅此数字）写入 `answer.txt`。
- verify：`fileEquals answer.txt expect=sum`。
- 打点：是否会整读 2 万行进上下文（stock read 工具的代价）vs 一条 shell 聚合命令。

### 7.4 fix-build —— 多轮错误循环

- fixture `brokenProject{seed:11}`：
  - `package.json`（name/scripts.test="node test.js"，无依赖）；
  - `test.js`：基于 `node:assert` 的 6~8 个断言，require `src/*.js`；
  - `src/` 3 个文件，注入 3 个单行 bug（off-by-one、错误比较运算符、缺失 trim）；
  - **不变式**：修复前 `node test.js` 必失败、正确修复后必通过（单测守护）；
  - exports：`testSource`（test.js 的精确内容，防作弊）。
- prompt：运行 `node test.js`，当前失败；修复 `src/` 里的 bug 使测试通过；不得修改 `test.js`。
- verify：`command{command:"node",args:["test.js"],exitCode:0}` + `fileEquals test.js expect=testSource`。
- 打点：错误-重试循环的轮次与 token；Windows 上 stock PowerShell vs dsh-ops bash 的挣扎差异。

### 7.5 log-stats —— shell 聚合

- fixture `logStats{seed:13, files:50, linesPerFile:400}`：
  `logs/app_00.log … app_49.log`，每行 `INFO|WARN|ERROR` 前缀 + 随机文本。
  exports：`report`（50 行 `"<文件名> <ERROR行数>"`，按文件名字典序，文件名不带 `logs/` 前缀）。
- prompt：统计每个 `logs/*.log` 文件中包含 `ERROR`（区分大小写）的行数，
  按 `<filename> <count>` 格式一行一个写入 `errors.txt`，按文件名字典序，文件名不带目录前缀。
- verify：`fileLines errors.txt expect=report`。
- 打点：一条命令完成 vs 多次读文件；工具输出的裁剪与压缩。

## 8. Windows 环境搭建（写进 bench/README.md 的主体）

一次性准备：

```console
:: 1) 创建两个 profile（只初始化，不跑任务；若 --dump-config 不触发初始化则改跑一条 smoke 任务）
dsh bench-base --from-default-profile headless --dump-config >NUL
dsh bench-cand --from-default-profile headless --dump-config >NUL

:: 2) 候选 profile 安装被测插件（三选一）
dsh plugin --profile bench-cand add dsh-ops@0.3.0
dsh plugin --profile bench-cand add C:\path\to\dsh-ops-checkout
dsh plugin --profile bench-cand add .\dsh-ops-0.3.1.tgz

:: 3) 两个 profile 的 %USERPROFILE%\.dsh\profiles\<name>\cordis.patch.yml 里
::    粘贴同一个 llm-pi-ai providers 块（你的 token 服务器路由）并钉死默认模型：
```

```yaml
- id: llm-pi-ai
  config:
    providers:
      bench-server:
        baseURL: https://<你的服务器>/v1
        apiKeyEnv: BENCH_SERVER_API_KEY
        api: openai-completions
        models:
          - id: <模型id>
            contextWindow: 131072
            maxTokens: 16384
- id: agent-default-model
  config:
    provider: bench-server
    model: <模型id>
```

:: 4) 设置 `BENCH_SERVER_API_KEY` 环境变量（或写入 `~/.dsh/.credentials.yaml`）。

冒烟自检（确认 usage 上报，见 2.6）：

```console
dsh --profile bench-base --json "Write the single word OK into ok.txt"
:: 检查输出的 step_end 事件里有没有 usage 字段；没有 → 先解决服务器 include_usage
```

日常对比：

```console
node bench/run.mjs --label base-stock  --profile bench-base --repeat 3
node bench/run.mjs --label cand-ops    --profile bench-cand --repeat 3
node bench/compare.mjs base-stock cand-ops --fail-on both
```

README 还需包含：会话目录清理提示（2.5）、方差与免责声明（第 10 节口径）、
`--dry-run`/`--list` 用法、如何新增任务（4.1/4.2 格式）。

## 9. 仓库接线

- `package.json` scripts 增加：`"bench": "node bench/run.mjs"`、`"bench:compare": "node bench/compare.mjs"`。
- `.gitignore` 增加：`bench/runs/`。
- `test/bench.test.mjs`（进现有 `node test/run.mjs` 门禁，任何平台可跑，不 spawn dsh）：
  - fixtures：同 seed 两次生成逐字节一致；各生成器 exports 与内容自洽
    （matches 恰好 12 个且非目标文件不含 needle；csv sum 与重新遍历一致；
    brokenProject 修复前 `node test.js` 失败）；
  - verify：7 种检查类型的通过/失败路径（临时目录内）；
  - aggregate：喂 2.2 节形状的合成 NDJSON → 精确断言各计数与 usage 求和；
    缺 usage 的 step → `usageReported=false`；坏行 → `malformedLines`；
  - compare-core：合成两份 summary → Δ%、median/min、passRate、门禁判定、
    model-mismatch 与 usage-incomplete 警告。
- 不动 README.en.md / README.zh.md（避免与上游 docs 重构冲突）；发现性靠
  `bench/README.md` + package.json scripts。需要时后续再在主 README 加一行链接。

## 10. 方法论与免责声明（报告固定脚注）

1. **公平性锚**：两侧 profile 必须同 provider、同 model、同上下文/输出配置；
   run 目录保存 `dump-config.txt` 作为证据；compare 检测到不一致即警告。
2. **方差**：模型输出非确定；单次差异在噪声内没有意义。默认 repeat=3 取中位数，
   正式对比建议 repeat≥3；报告同时给 min 以观察离散度。
3. **通过率是门禁的一半**：token 降了但任务做不对 = 无效优化（fix-build 还有
   test.js 防篡改校验）。
4. **口径**：grandTotal=四桶之和（cacheRead/cacheWrite 是否"省钱"取决于计价，
   自托管服务器无所谓，但报告分桶展示以便映射到计价模型）。
5. **自测声明**：结果只描述"这台机器、这个模型、这组任务、这个时间"的测量，
   不构成可外推的官方节省百分比（对齐 PROVENANCE.md 的口径约束）。

## 11. 实施步骤清单（Windows 侧按序执行）

| # | 步骤 | 验收标准 |
| --- | --- | --- |
| 0 | 环境自检：`dsh --version`、node ≥22.19、token 服务器在线 | 版本打印正常 |
| 1 | `bench/lib/fixtures.mjs`（5 生成器 + PRNG） | 单测：确定性、exports 自洽 |
| 2 | `bench/lib/verify.mjs` | 单测：7 类检查通过/失败路径 |
| 3 | `bench/lib/aggregate.mjs` | 单测：合成 NDJSON 精确聚合 |
| 4 | `bench/lib/tasks.mjs` + 5 个 `*.task.json` | `run.mjs --list` 打印 5 任务；结构校验通过 |
| 5 | `bench/run.mjs`（含 --dry-run/--keep/超时杀树） | `--dry-run` 全任务 fixture 生成 + verify 全失败（未开工） |
| 6 | profile 搭建（第 8 节）+ **smoke 确认 step_end 带 usage** | smoke 事件流里 usage 字段存在 |
| 7 | 两侧各跑 1 任务 × repeat 1（真模型） | metrics/summary/report 落盘，verify=PASS |
| 8 | `bench/lib/compare-core.mjs` + `bench/compare.mjs` | 单测通过；对步骤 7 的两个 run 出报告 |
| 9 | `test/bench.test.mjs` 全量接入 | `node test/run.mjs bench` 绿 |
| 10 | 全量：5 任务 × 2 profile × repeat 3 | 两份 summary + 对比报告；人工复核一份 events.ndjson |
| 11 | `bench/README.md`、`.gitignore`、package.json scripts | 文档可从零复现步骤 6-10 |

预估代码量：lib 四件套 ~700 行，run/compare ~450 行，任务 JSON ~120 行，单测 ~250 行。

## 12. 已知风险与对策

| 风险 | 对策 |
| --- | --- |
| 服务器流式不回 usage（2.6） | 步骤 6 前置冒烟；harness 明确降级为"仅步数/工具计数"并拒绝 token 结论 |
| `--dump-config` 不触发 profile 初始化 | 兜底：用一条 smoke 任务完成初始化（README 写明两种路径） |
| 模型把 prompt 当耳旁风（如仍改了 test.js） | verify 防作弊检查；passRate 进对比报告 |
| 临时工作区在 `os.tmpdir()`，Windows 路径含空格/中文 | spawn 用数组参数不经 shell；路径全程 `path.join` |
| 会话目录在 `~/.dsh/sessions` 累积 | README 清理指引；不自动删（不碰用户数据） |
| 长任务卡死（服务器慢/模型死循环） | 每任务 timeout + 进程树击杀 + `timedOut` 标记计入失败 |
| repeat 期间服务器热状态不同（KV cache 等） | 串行执行；报告 cache 桶分列；必要时 repeat 间加固定间隔（run.mjs `--sleep-ms`，实现时顺手加） |
