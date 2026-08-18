# dsh-cron-scheduler

**系统级 cron 定时任务插件 for DeepSeek Harness**：规则存为 **Cron 表达式**，由用户机器的 **crontab 在进程外执行 headless 任务**，Web 端负责规则管理、部署与结果归类。

- 定时执行不依赖 DSH Web 进程存活（机器开机 + cron 即可跑）
- 支持完整 5 字段 Cron 表达式 + `@reboot/@daily/@hourly/@weekly/@monthly`
- 每次运行都是全新 root Agent + Session，结果自动挂到规则所属工作区，聊天里点开即见
- Web 设置页 + Agent 工具双入口管理

> 社区插件，非 DeepSeek 官方产品。

## 架构

```
系统 crontab（唯一调度器，支持任意 Cron 表达式）
   └─ wrapper 脚本（每规则一个，~/.dsh/cron-scheduler/wrappers/<id>.sh）
        ├─ 设置 DSH_PERMISSION_MODE（read-only / workspace-write 沙箱）
        ├─ 写运行 manifest（queued→running→succeeded/failed/skipped）
        ├─ cd 到规则工作区
        └─ dsh --profile headless "[dsh-cron:task=<id>] <名称>\n\n<prompt>"
              └─ 全新持久会话（cwd=工作区，首条消息带 task 标记）
Web 端（dsh-cron-scheduler host 插件）
   ├─ 规则 CRUD → 同步 crontab marked block + wrapper
   ├─ 会话监听器：扫描新会话 → 匹配 task 标记 → attach 到工作区 + 回填 sessionId/摘要
   └─ RPC + agent 工具（automation_*）
```

### 数据位置

| 内容 | 路径 |
|---|---|
| 规则定义 | `~/.dsh/cron-scheduler/definitions/<id>.json` |
| wrapper 脚本 | `~/.dsh/cron-scheduler/wrappers/<id>.sh` |
| 任务文本 | `~/.dsh/cron-scheduler/tasks/<id>.txt` |
| 运行记录 | `~/.dsh/cron-scheduler/runs/<runId>.json` |
| 运行日志 | `~/.dsh/cron-scheduler/logs/<id>.log` |
| 并发锁 | `~/.dsh/cron-scheduler/locks/<id>.lock` |

crontab 中插件管理的条目位于明确的标记块内：

```
# >>> dsh-cron-scheduler managed block >>>
0 9 * * 1-5 /bin/bash /Users/you/.dsh/cron-scheduler/wrappers/task-abc123.sh >> /Users/you/.dsh/cron-scheduler/logs/task-abc123.log 2>&1
# <<< dsh-cron-scheduler managed block <<<
```

## 安装

```sh
# 0) 先构建
cd dsh-cron-scheduler && pnpm install && pnpm check

# 1) 装进 web profile（dsh 命令按你的安装方式）
dsh plugin --profile web add ~/Coding/github/mappedinfo/dsh-cron-scheduler
# 或（源码 checkout 里的方式）：
node /path/to/deepseek-harness/apps/cli/lib/bin.js plugin --profile web add /path/to/dsh-cron-scheduler

# 2) 重启 DSH Web 并硬刷新浏览器
```

重启后：**设置 → 定时任务** 出现管理页；侧边栏工作区树会自动出现每次运行的会话。

## 使用

- **设置 → 定时任务**：新建（名称 / Cron 表达式或预设 / 任务说明 / 工作区 / 权限）、编辑、暂停/恢复、立即运行、删除；下方为运行历史（排队中/运行中/成功/失败/跳过 + 结果会话）。
- **对话里**：告诉 agent「每天 9 点运行 <任务>」，agent 会用 `automation_create` 创建（同样支持 `automation_list / automation_runs / automation_update / automation_run_now / automation_delete`）。

### Cron 语法

5 字段：`分 时 日 月 周`。支持：

- `*` 任意；`a-b` 范围；`*/n` 与 `a-b/n` 步长；`a,b,c` 列表
- 月份/星期名称：`JAN-DEC`、`MON-SUN`（不区分大小写；星期 `0/7` = 周日）
- 快捷：`@reboot`、`@daily`、`@hourly`、`@weekly`、`@monthly`、`@yearly`

示例：`0 9 * * 1-5`（工作日 9:00）、`*/15 * * * *`（每 15 分钟）、`0 9 1 * *`（每月 1 日 9:00）。

时区以**系统时区**解释（cron 行为）；不支持秒级精度。

## 配置（cordis.patch.yml 覆盖）

| 配置 | 默认 | 说明 |
|---|---|---|
| `profile` | `headless` | wrapper 使用的 headless profile 名 |
| `pollSeconds` | `10` | 会话监听器轮询间隔 |
| `historyLimit` | `100` | 每规则保留的运行记录数 |
| `dshCommand` | 自动探测 | 显式指定 wrapper 里的 dsh 命令绝对路径（自动探测失败时设置，见下） |

### dsh 命令路径（重要）

wrapper 在 cron 环境下执行，PATH 极简。插件生成 wrapper 时会自动探测 `dsh`（`DSH_BIN` 环境变量 → `command -v dsh`）。若探测不到（例如你用 `pnpm dsh web` 启动、`dsh` 不在 PATH），请在 profile 的 `cordis.patch.yml` 里显式指定：

```yaml
- id: cron-scheduler
  config:
    dshCommand: /Users/you/deepseek-harness/apps/cli/lib/bin.js
```

设置页顶部会显示当前解析到的 dsh 命令与来源（config / DSH_BIN / PATH / 默认 dsh）。`@reboot` 任务在下次登录时执行。

## 权限与安全

- 每条规则可选 `read-only`（默认）或 `workspace-write` 沙箱，通过 wrapper 的 `DSH_PERMISSION_MODE` 生效；不提供 full-access。
- 同一规则同时只允许一个运行：并发触发（cron 与手动叠加）自动记为 `skipped`。
- 运行历史保留用于审计；删除规则不影响历史。
- 会话标记（首条消息 `[dsh-cron:task=<id>]`）用于回挂，属"不可信内容"，不会注入指令。

## 已知限制

- 结果归属是**最终一致**的：Web 进程在运行期间轮询并 attach 会话；Web 未启动时运行照常完成，重启 Web 后会话会被补挂。
- 会话标题目前是自动生成（含标记前缀）；自定义标题是后续增强。
- 模型/预设为 headless 默认；按规则选择模型尚未实现。

## 开发

```sh
pnpm install
pnpm check      # typecheck + build
node scripts/dev-test.mjs   # cron 校验 + wrapper 全链路自测（不碰真实 crontab）
```

## License

MIT
