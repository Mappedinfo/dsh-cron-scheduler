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

## 安装（一条命令，零配置）

**方式 A：npm 发布版**（发布后）
```sh
dsh plugin --profile web add @mappedinfo/dsh-cron-scheduler
```

**方式 B：Git 仓库直装**（无需发布）
```sh
dsh plugin --profile web add github:Mappedinfo/dsh-cron-scheduler
```

**方式 C：本地源码 + 一键脚本**
```sh
git clone https://github.com/Mappedinfo/dsh-cron-scheduler.git
cd dsh-cron-scheduler && ./scripts/install.sh        # 构建 + 安装 + 提示，默认 web profile
```

装完**重启 DSH Web 并硬刷新浏览器**即可，无需任何手工配置：设置 → 定时任务 出现管理页，侧边栏工作区树自动出现每次运行的会话。

> `dsh plugin add` 会自动把插件的 bundle 层（cordis.patch.yml）和客户端模块（`dsh.client` → `lib/client.js`）注册进 profile，这是 DSH 的官方插件安装通道。

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

## 配置（一般不需要动）

| 配置 | 默认 | 说明 |
|---|---|---|
| `profile` | `headless` | wrapper 使用的 headless profile 名 |
| `pollSeconds` | `10` | 会话监听器轮询间隔 |
| `historyLimit` | `100` | 每规则保留的运行记录数 |
| `dshCommand` | 自动解析 | 显式覆盖 wrapper 用的 dsh 命令（极少需要） |

### dsh 命令自动解析（零配置）

wrapper 在 cron 环境下执行、PATH 极简，所以插件在生成 wrapper 时会在 **dsh web 进程内**按链自动解析 dsh：

1. `config.dshCommand`（显式覆盖）
2. `$DSH_BIN` 环境变量
3. `command -v dsh`（PATH 全局安装）
4. **从当前进程推导 + 自动生成 shim**：读取 `process.argv[1]`（`lib/bin.js` 或 dev 模式的 `src/bin.ts`），在 `~/.dsh/cron-scheduler/bin/dsh` 生成 `exec <node> <cli入口> "$@"` shim——覆盖 `pnpm dsh web`、源码 checkout、npm 全局安装等常见方式
5. 兜底 `dsh` + 设置页告警

设置页顶部会显示解析到的命令与来源（config / DSH_BIN / PATH / 自动 shim / 兜底）。`@reboot` 任务在下次登录时执行。

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

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| ≥ 0.1.5 | ✅ 支持（当前） |
| 0.1.0-rc.x | ⚠️ 不支持：0.1.5 起 `connection.rpc.handle()` 内部改为通过 `owner.webServer` 注册路由，该方法在 0.1.5 对插件调用方不可用；本插件改为**自行在 webServer 注册 RPC 路由**并实现官方信封，因此需要具备 `webServer` 服务的 0.1.5+ |

## 故障排查

- **设置页显示"部署失败"**：查看规则行的 `deployError`；插件也会把 apply/部署失败写入 `/tmp/dsh-cron-scheduler-failure.log`（可用环境变量 `DSH_CRON_FAILURE_LOG` 改路径）。
- **crontab 命令超时（"crontab 超时…可能被陈旧锁占用"）**：系统 crontab 被中断的写入留下了陈旧锁（`/var/at/tabs`，root 700）。写入会快速失败并报错，不会卡住 DSH Web；恢复需清理锁或重启：
  ```sh
  sudo ls -la /var/at/tabs/          # 查看残留
  sudo rm -rf /var/at/tabs/<残留项>   # 或直接重启机器
  ```
- **多实例安全**：托管块标记带 DSH home（`# >>> dsh-cron-scheduler managed block: <base> >>>`），不同 `DSH_HOME` 的实例互不清理对方条目；读取失败时绝不写入，避免覆盖用户 crontab。
