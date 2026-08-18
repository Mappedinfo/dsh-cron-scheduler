# DSH 插件专区发布模板（Showcase Post Template）

依据 [deepseek-ai/deepseek-harness discussions/2004 — Plugin Category Guidelines](https://github.com/deepseek-ai/deepseek-harness/discussions/2004) 整理。

发布到 https://github.com/deepseek-ai/deepseek-harness/discussions/categories/plugins 前，请对照清单自查：

- [ ] 一个主题只介绍一个项目
- [ ] 项目与 DSH 有实际集成（有可运行的安装/调用方式）
- [ ] 标题格式：`DSH | 项目名称 | 一句话说明用途`
- [ ] 正文显著标注**非官方项目**
- [ ] 正文包含：项目地址、简短介绍、截图、与 DSH 的集成方式
- [ ] 语言建议中英双语（规则为中英各一份；社区 Upvote 排序，英文可提升可见度）

---

## 一、空白模板（通用）

> **非官方项目，由社区成员独立开发和维护。**
> **Unofficial project, independently developed and maintained by community members.**

### Project URL / 项目地址
https://github.com/<org>/<repo>

### Introduction / 项目介绍
（2–4 句：项目解决什么问题、核心能力、如何与 DSH 配合使用）

**中文**：
…

**English**：
…

### How it integrates with DSH / 与 DSH 的集成方式
（安装命令 + 入口位置 + 关键交互，1 段即可）

```sh
dsh plugin --profile web add <package-or-github-url>
```

### Screenshots / 截图
| 说明 | 截图 |
|---|---|
| （如：设置页入口） | ![](https://…) |
| （如：运行结果在会话中的展示） | ![](https://…) |

---

## 二、示例：dsh-cron-scheduler（可直接使用）

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

安装（git 直装，pnpm 会自动构建）：

```sh
dsh plugin --profile web add github:Mappedinfo/dsh-cron-scheduler
```

重启 DSH Web 后：

- **设置 → 定时任务**：新建/编辑/暂停/恢复/立即运行/删除规则，下方为运行历史（排队中/运行中/成功/失败/跳过）与结果会话
- **对话里**：直接告诉 Agent「每天 9 点运行 <任务>」，Agent 会调用 `automation_create`（另有 `automation_list / automation_runs / automation_update / automation_run_now / automation_delete`）
- **执行链路**：crontab → wrapper（设置 `DSH_PERMISSION_MODE` 沙箱、写运行记录）→ `dsh --profile headless`（全新持久会话，cwd=工作区、首条消息带 `[dsh-cron:task=<id>]` 标记）→ Web 端会话监听器把会话 attach 到工作区并回填运行记录
- **零配置**：dsh 命令按 `config → DSH_BIN → PATH → 自动生成 shim` 解析，无需手工配置路径

### Screenshots / 截图

> 待补充：截图建议 3 张左右，放到仓库 `docs/screenshots/` 后引用，例如——

| 说明 | 截图 |
|---|---|
| 设置页：规则列表 + 运行历史 | ![](docs/screenshots/settings.png) |
| 对话创建：Agent 调用 automation_create | ![](docs/screenshots/chat-create.png) |
| 运行结果：会话出现在工作区树 | ![](docs/screenshots/run-session.png) |
| 部署验证：crontab 标记块 | ![](docs/screenshots/crontab.png) |

---

## 三、其他项目复用提示

同一 org（`Mappedinfo`）下其他 DSH 项目（如 `dsh-tool-vision-read`）发布时，复制「一、空白模板」填充即可，注意：

- 标题一句话说明要落在**对用户的价值**上，而不是技术名词堆砌
- 截图是社区排序（Upvote）的主要依据之一，建议至少 2 张真实界面
- 每个讨论只放一个项目；同一项目不要重复发帖
