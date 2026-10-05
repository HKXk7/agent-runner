# Agent Runner

DB-backed 的 **Agent 长任务执行引擎 + 可观测控制台**。把 AI Agent 的任务从「单次调用、几秒返回」升级到「能可靠跑完的长任务」——支持租约防双跑、步骤幂等、成本熔断、人工审批门、重试退避、append-only 审计，并配一个实时 trace 的控制台前端。

零外部依赖、零 API key 即可跑通全链路（内置 Mock LLM + fixture）。

## 特性

- **DB-backed 任务队列**：租约（lease）抢占 + 心跳续约 + 过期回收，worker 崩溃自动恢复，天然防双跑
- **步骤级幂等**：`idempotency_key` 唯一约束 + 完成态跳过，at-least-once 语义下副作用不重复
- **成本熔断**：token / 金额预算，步级检查点超限自动进入可恢复的暂停态，调高预算后断点续跑
- **人工审批节点**：等待状态持久化到数据库，进程崩溃也不丢审批决定
- **分级重试**：步骤级指数退避（attempt 持久化，崩溃可续）+ 任务级重新入队（幂等跳过已完成步）
- **append-only 审计事件流**：数据库触发器层面禁止 UPDATE/DELETE，任何代码路径都改不了历史
- **实时控制台**：SSE 推送 trace 时间轴（每步耗时 / token / 成本 / attempt），任务看板、审批队列、收件箱、成本面板
- **可插拔 LLM / 推送**：`LLMProvider` 接口 + Mock 零 key 演示；`PushChannel` 抽象（Server酱 / PushPlus / 文件降级）

## 快速开始

### 环境要求

- Node.js ≥ 22（better-sqlite3 需要 Node 20+，本项目在 Node 22 LTS 上验证）
- Windows / macOS / Linux 均可；无需 Docker、无需数据库服务（SQLite 零配置）

### 启动

```bash
git clone https://github.com/HKXk7/agent-runner.git
cd agent-runner
npm install
npm run build:web && npm start
```

打开 <http://localhost:8787>。

### 零凭据演示（不需要任何 API key）

默认使用内置 `MockProvider` + 本地 fixture，全链路可跑：

1. 控制台「新建任务」→ 类型选 `demo_pipeline` → payload 填 `{"approve":true}` → 入队，观察 trace 时间轴实时滚动，到审批门自动暂停
2. 侧边栏「审批队列」→ 批准 → 任务断点续跑至完成，收件箱出现日报
3. 再入队一条 `demo_pipeline`，把 token 预算填 `10` → 触发成本熔断 → 详情页「提升预算续跑」→ 已完成步骤被幂等跳过

## 配置

复制 `.env.example` 为 `.env`，或直接 export 环境变量。全部可选，不配置即为零 key mock 模式：

| 变量 | 作用 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 接入真实 LLM | 任意 OpenAI 兼容端点，不填则用 Mock |
| `OPENAI_BASE_URL` | LLM 端点 | 默认 `https://api.openai.com/v1`，可用 DeepSeek 等 |
| `OPENAI_MODEL` | 模型名 | 默认 `gpt-4o-mini` |
| `AGENT_RUNNER_CONCURRENCY` | 单进程并发槽位 | 默认 `1` |
| `AGENT_RUNNER_CRON` | 是否开启定时任务 | `0` 关闭（默认开，每日 07:30 抓通知） |
| `AGENT_RUNNER_MOCK` | 强制 mock 抓取 | `1` 强制用 fixture，不抓真实网页 |
| `SERVERCHAN_SENDKEY` | 微信推送（Server酱） | 不填则回退文件收件箱 |
| `PUSHPLUS_TOKEN` | 微信推送（PushPlus） | 不填则回退文件收件箱 |
| `PORT` | HTTP 端口 | 默认 `8787` |

## 命令

| 命令 | 说明 | 是否花钱 |
|---|---|---|
| `npm install` | 安装依赖 | 否 |
| `npm run build:web && npm start` | 构建控制台并一键起全栈 | 否（无 key 时） |
| `npm run dev` | 开发模式，server @8787（tsx watch） | 否 |
| `npm run dev:web` | 开发模式，web @5173（Vite HMR） | 否 |
| `npm run smoke` | 21 项冒烟断言，覆盖全部核心机制 | 否 |
| `npm run enqueue -- <type> [--payload json] ...` | CLI 入队（不依赖 HTTP） | 视任务而定 |

## 目录结构

```
agent-runner/  (npm workspaces, TypeScript 全栈)
  shared/       # 状态机 + 类型契约（前后端唯一真源）
  server/       # Hono + better-sqlite3 (WAL)
    queue/      #   lease.ts（租约） scheduler.ts（并发池） worker.ts（重试） jobs-repo.ts
    steps/      #   idempotency.ts（幂等） cost.ts（熔断）
    approvals/  #   审批门持久化
    audit/      #   append-only 审计（DB 触发器兜底）
    push/       #   PushChannel 抽象（Server酱/PushPlus/文件降级）
    llm/        #   LLMProvider 接口 + MockProvider + OpenAI 兼容
    jobs/       #   demo_pipeline / school_notice / html-parse（鲁棒解析）
    routes/     #   REST + SSE
  web/          # React + Vite + Zustand（看板/时间轴/审批/收件箱/成本）
  docker/       # Postgres 升级路径（postgres-schema.sql + SKIP LOCKED）
```

## 核心机制

### 任务状态机

```
pending → running(leased) → done / failed
running → paused_approval → running      （人工审批）
running → breached → running             （预算上调后恢复）
任意非终态 → cancelled
```

### 租约（防双跑）

抢占租约是一条原子 `UPDATE ... RETURNING`：只有满足「无租约 或 租约已过期」的 job 才能被某个 worker 领走，并把 `lease_owner` 设为该 worker、`lease_expires_at` 设为未来某个时刻。worker 执行期间心跳续约；崩溃后租约自然过期，调度器回收重拉。SQLite 单写者下等价于 Postgres 的 `SELECT ... FOR UPDATE SKIP LOCKED`（升级路径见 `docker/postgres-schema.sql`）。

### 步骤幂等

每步有 `idempotency_key`（唯一约束）。重跑时先查「该 key 是否已 done」，是则直接跳过；唯一约束是并发下的兜底。这样在 at-least-once 交付语义下，副作用（如推送、写库）不会重复发生。

### 成本熔断

job 有 token 与金额两个预算上限。每步完成后累加用量并检查，超限即把 job 置为 `breached`（可恢复暂停态）+ 释放租约 + 写审计。操作者调高预算后自动回 `running`，调度器重新拉起，从断点续跑、已完成步骤幂等跳过。

### 人工审批节点

步骤可声明 `requiresApproval`（静态开关或按 payload 动态决定）。命中后写入 `approvals` 表并把 job 置为 `paused_approval`——等待状态落在数据库而非进程内存，进程崩溃重启后审批决定与任务状态都不丢。批准则回 `running` 续跑，驳回则取消。

### 重试与退避

- **步骤级**：`maxRetries` 内失败按指数退避重试，`attempt` 字段持久化，崩溃后重试计数不丢。
- **任务级**：`maxAttempts` 内失败自动回 `pending` 重新入队，已完成步骤幂等跳过。

### 审计事件流

所有状态变更只做 `INSERT`。SQLite 触发器在**数据库层面**对 `audit_events` 的 UPDATE/DELETE 直接 `ABORT`，任何应用层代码路径都无法篡改历史。`smoke.ts` 里有自证用例。

## 设计取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 数据库 | SQLite WAL（better-sqlite3） | 零配置零依赖，单机即可跑；同步 API 简化并发模型。多实例共享 SQLite 也安全（WAL + busy_timeout + lease 原子抢占） |
| 为什么不直接上 Postgres | 留升级路径 | 单机 MVP 用 SQLite 降低上手门槛；真并发 + `SKIP LOCKED` 见 `docker/postgres-schema.sql` |
| 为什么不直接 Temporal / Celery / BullMQ | 自建精简实现 | 目标是讲清 durable execution 的核心原理（lease/幂等/熔断/审批/审计），而非依赖黑盒框架；README 与代码即文档 |
| Web 框架 | Hono | 轻量、TS 类型友好、原生支持 SSE 流式响应 |
| 实时推送 | SSE 而非 WebSocket | 单向推送足够，协议更简单、自动重连、无需额外依赖 |
| 审计不可篡改 | 数据库触发器 | 应用层能保证的是「正常路径」，数据库层是「任何路径」的最后防线 |
| LLM 接入 | Provider 接口 + Mock | 无 key 也能测试/演示，本身是可测试性的设计，而非妥协 |

## 常见问题

**这能用于生产吗？** 定位是「理解 durable execution 原理的参考实现 + 单机 MVP」。生产多 worker 建议切 Postgres + `SKIP LOCKED`（`docker/` 已备好 schema），推送接真实渠道。

**为什么不用 Temporal？** Temporal 是完整的 durable execution 框架，功能强但重；本项目是它的一个精简教学实现，让你看清 lease、幂等、审批这些机制在 DB 层是怎么落地的。两者不是替代关系。

**支持分布式多 worker 吗？** 单进程并发（`AGENT_RUNNER_CONCURRENCY=N`）+ 多实例共享 SQLite 都支持，lease 原子抢占天然防双跑。真并发 + `SKIP LOCKED` 切 PG。

**审批节点崩溃了怎么办？** 等待状态在数据库，重启后调度器会重新拉起未完成的 job，审批决定不丢。

**如何接真实 LLM？** 设 `OPENAI_API_KEY`（配合 `OPENAI_BASE_URL` 可指向 DeepSeek 等任意 `/v1/chat/completions` 兼容端点），不设则自动用 Mock。

## License

[MIT](./LICENSE)
