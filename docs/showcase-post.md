# DSH 插件专区发布稿：dsh-cron-scheduler（可直接复制发帖）

> 依据 [deepseek-ai/deepseek-harness discussions/2004 — Plugin Category Guidelines](https://github.com/deepseek-ai/deepseek-harness/discussions/2004)。
> 截图在 `docs/screenshots/`，发帖时上传图片并替换链接。

---

## 标题

**DSH | dsh-cron-scheduler | 系统级 Cron 定时任务插件：Cron 表达式 + 进程外 headless 执行，Web 端管理规则与运行结果**

---

## 正文

> **非官方项目，由社区成员独立开发和维护。**
> **Unofficial project, independently developed and maintained by community members.**

### Project URL / 项目地址

https://github.com/Mappedinfo/dsh-cron-scheduler

### Introduction / 项目介绍

**中文**：
dsh-cron-scheduler 是 DeepSeek Harness 的系统级 Cron 定时任务插件。规则以标准 5 字段 Cron 表达式定义（支持 `*/步长`、`-范围`、`,列表`、`JAN-DEC/MON-SUN` 名称与 `@reboot/@daily/@hourly/@weekly/@monthly`），由用户机器的 crontab 在**进程外**执行 headless 任务——DSH Web 不必保持运行，机器开机即可按时触发。每次运行都会启动一个全新会话并把最终回复写进该会话；会话自动挂到规则所属工作区，在聊天里点开即可看到结果。插件提供 Web 设置页与 Agent 工具（`automation_*`）双入口管理规则与运行历史，零配置安装（自动解析 dsh 命令并生成 shim）。

**English**：
dsh-cron-scheduler is a system-level cron scheduler plugin for DeepSeek Harness. Rules are defined with standard 5-field cron expressions (steps, ranges, lists, month/weekday names, and `@reboot/@daily/@hourly/@weekly/@monthly` shortcuts) and executed out-of-process by the user's crontab via the headless profile — no need to keep DSH Web running. Each run starts a fresh session whose final reply is written back into that session, auto-attached to the rule's workspace so you can open the result right in the chat. Rules and run history are managed from a Web settings page and agent tools (`automation_*`). Installation is zero-config (the plugin auto-resolves the dsh command and generates a shim).

### How it integrates with DSH / 与 DSH 的集成方式

安装（git 直装，pnpm 自动构建；也可 `npm publish` 后一条命令装）：

```sh
dsh plugin --profile web add github:Mappedinfo/dsh-cron-scheduler
```

重启 DSH Web 后：

- **设置 → 定时任务**：新建/编辑/暂停/恢复/立即运行/删除规则，下方为运行历史（排队中/运行中/成功/失败/跳过）与结果会话
- **对话里**：直接告诉 Agent「每天 9 点运行 <任务>」，Agent 会调用 `automation_create`（另有 `automation_list / automation_runs / automation_update / automation_run_now / automation_delete`）
- **执行链路**：crontab → wrapper（设置 `DSH_PERMISSION_MODE` 沙箱、写运行记录）→ `dsh --profile headless`（全新持久会话，cwd=工作区、首条消息带 `[dsh-cron:task=<id>]` 标记）→ Web 端会话监听器把会话 attach 到工作区并回填运行记录
- **零配置**：dsh 命令按 `config → DSH_BIN → PATH → 自动生成 shim` 解析，无需手工配置路径

### Screenshots / 截图

| 说明 | 截图 |
|---|---|
| 设置 → 定时任务：规则列表 + 部署状态 | ![设置页](docs/screenshots/01-settings.png) |
| 运行历史：状态 + 结果会话入口 | ![运行历史](docs/screenshots/02-runs.png) |
| 运行结果出现在聊天里（晚间研究复盘，含产物 progress_tracker.md） | ![运行会话](docs/screenshots/03-session.png) |
| 部署验证：crontab 标记块 + wrapper（系统 cron 在进程外执行） | ![crontab](docs/screenshots/04-crontab.png) |

---

## 附：通用空白模板（其他项目复用）

> **非官方项目，由社区成员独立开发和维护。**
> **Unofficial project, independently developed and maintained by community members.**

### Project URL / 项目地址
https://github.com/<org>/<repo>

### Introduction / 项目介绍
（2–4 句：解决什么问题、核心能力、如何与 DSH 配合）

**中文**：…

**English**：…

### How it integrates with DSH / 与 DSH 的集成方式
（安装命令 + 入口位置 + 关键交互）

```sh
dsh plugin --profile web add <package-or-github-url>
```

### Screenshots / 截图
（至少 2 张真实界面：设置页入口 + 核心功能展示）

---

## 发帖前 Checklist

- [ ] 一个主题一个项目
- [ ] 标题格式：`DSH | 项目名称 | 一句话说明`
- [ ] 显著标注非官方
- [ ] 正文含地址 / 介绍 / 截图 / 集成方式
- [ ] 上传截图到 GitHub 或图床后替换 `docs/screenshots/...` 链接
- [ ] 中英双语（可选，提升 Upvote 可见度）
