# At-Pet for Codex

把本机 Codex 的工作状态接入 [At-Pet](https://github.com/At-PetAdmin/At-Pet) Windows 桌宠。使用 Codex 原生 lifecycle hooks 和 At-Pet 的本地 HTTP API，零第三方运行依赖，也不需要 OpenAI API Key。

这是独立的接入插件，桌宠窗口、精灵图、宠物库由 At-Pet 主程序提供。参考了上游的 [Codex 适配](https://github.com/At-PetAdmin/At-Pet/tree/main/integrations/agent-plugins/openai-codex)，补充了取消、模型失败、子代理、权限请求清理和可移植的启动命令。

## 前提

- Windows 10/11，安装 Node.js 22 或更新版本，`node` 在 Codex 进程的 PATH 中。
- At-Pet 正在运行；默认地址 `http://127.0.0.1:8765`。
- 支持插件与 hooks 的本地 Codex CLI / 桌面客户端。开发时使用 `codex-cli 0.166.0-alpha.6`。
- hooks 在本机执行。云端 Codex 无法直接访问你电脑的 `127.0.0.1`。

## 安装

从 GitHub 安装（私有仓库需要对应组织的访问权限）：

```powershell
codex plugin marketplace add At-PetAdmin/codex-at-pet
codex plugin add codex-at-pet@at-pet-local
```

在解压后的插件根目录运行（本项目为 `D:\code\codex_at-pet`）：

```powershell
node scripts/cli.mjs doctor
codex plugin marketplace add .
codex plugin add codex-at-pet@at-pet-local
```

重启桌面客户端或新开 Codex 会话，然后审核并信任插件的 hooks：CLI 输入 `/hooks`；桌面客户端打开 **Settings → Hooks** 或点击 **Review hooks**。审核是 Codex 对所有非托管 hooks 的要求，插件不会代替用户写入信任记录。插件更新后可能需要重新审核。

当前客户端若没有 `codex plugin add` 命令，可在添加 marketplace 后，从桌面插件目录选择 **At-Pet 本地插件** 并安装 **At-Pet for Codex**。

项目使用根目录 `plugin.json` 的 OpenAI 扩展配置，并提供 `.codex-plugin/plugin.json` 兼容入口。`.claude-plugin/marketplace.json` 是 Codex 官方支持的兼容目录索引，仅负责本地发现；插件本身使用 Codex 的 hooks 协议。安装后 Codex 读取缓存中的插件副本，修改源码后需要重新安装并审核。

不要同时安装本插件和上游 Codex 适配，否则一个 hook 会发送两次事件，并可能弹出两个权限请求。

## 效果

| Codex 事件 | At-Pet 事件 / 行为 |
| --- | --- |
| `UserPromptSubmit`、`PreModelRequest` | `thinking` |
| `PreToolUse` | `tool_start`，显示工具名 |
| `PostToolUse` | `tool_end`；结构化失败结果发 `error` |
| `PostModelRequest` | `failed` → `error`；`cancelled` → `cancelled`；普通完成不提前结束任务 |
| `PermissionRequest` | 桌宠弹出允许一次 / 拒绝，决定返回 Codex |
| `Stop` | `done` |
| `Interrupt` | `cancelled` |
| `SessionEnd` | `session_end`，移除会话 |
| `SubagentStart`、`SubagentStop` | 子会话 `thinking` / `done`，保留父会话 ID |
| `PreCompact`、`PostCompact` | `thinking` |
| `SessionStart` | 不发事件，避免恢复 / 压缩时清除活跃会话 |

At-Pet 的 Agent Monitoring 设置需要允许 `openai-codex`；想显示独立子代理桌宠时，还需启用对应选项。工具结果由各工具定义，插件识别结构化 `isError`、`success`、`status`、`exit_code` 和 `exitCode`；不会通过输出文字猜测是否失败。其他 hooks 的决定（例如另一个 Stop hook 继续任务）不在本插件可观测范围内。

## 权限和离线行为

默认 `relay` 模式把当前请求 POST 到 `/permission`，轮询请求 ID；只有明确收到 `allowed_once` 或 `denied` 才输出 Codex 的权限决定。等待上限 570 秒；超时、无效结果、HTTP 错误、桌宠离线或进程收到中断时会尝试取消桌宠弹窗，然后交回 Codex 自身审批。硬终止进程时无法保证清理。

可用 `notify` 模式仅发送权限状态，让所有决定仍由 Codex 界面处理。这个模式不弹出桌宠审批框。

普通状态请求默认 1.5 秒超时。hook 的错误以退出码 0 返回，桌宠不可用时 Codex 可以继续工作。只有权限请求的 JSON 决定会写到 hook 的 stdout；日志仅在调试时写到 stderr。

## 配置

在启动 Codex **之前**设置环境变量；桌面应用需完全退出后从设置了变量的终端启动，或使用用户环境变量并重启应用。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AT_PET_URL` | `http://127.0.0.1:8765` | 仅允许 `127.0.0.1`、`localhost`、`[::1]` 的 HTTP(S) origin；拒绝重定向 |
| `AT_PET_TIMEOUT_MS` | `1500` | 单次请求超时，50–2000 毫秒 |
| `AT_PET_PERMISSION_WAIT_MS` | `570000` | 权限等待上限，50–570000 毫秒 |
| `AT_PET_PERMISSION_MODE` | `relay` | `relay` 或 `notify` |
| `AT_PET_DEBUG` | 未设置 | `1` 时向 stderr 输出错误诊断 |

```powershell
$env:AT_PET_URL = 'http://127.0.0.1:8765'
$env:AT_PET_PERMISSION_MODE = 'notify'
codex
```

普通事件只传会话 ID、父子关系、模型和工具名称。不读取会话文件、不扫描进程，也不传提示词或工具输出。权限转发会向本机 At-Pet 提交工具说明 / 命令；其他工具提交 JSON 参数，描述最多 2000 字符。At-Pet 本地 API 不带身份验证，适用于同机可信程序。

## 验证与打包

```powershell
npm test
npm run check
npm run pack
```

已安装 Codex CLI 时，可额外运行 `node scripts/smoke-install.mjs`，在临时 Codex 配置目录中验证本地 marketplace 安装，不改动你现有的插件或 hooks 信任记录。

打包使用 Windows PowerShell / .NET，生成 `dist/codex-at-pet-0.1.0.zip`，包含点目录中的 manifest 和 marketplace，不包含测试、临时数据或依赖目录。

仅检查映射，不向桌宠发送请求：

```powershell
'{"hook_event_name":"PreToolUse","session_id":"demo","tool_name":"Bash"}' | node scripts/cli.mjs preview
```

让运行中的桌宠播放一轮模拟任务（结束后删除模拟会话）：

```powershell
npm run demo
```

诊断失败时，检查 At-Pet 是否启动、端口是否一致、Node 是否在 PATH、插件是否启用，以及 hooks 是否经过审核。`doctor` 检查 `/health` 连通性；测试使用独立的本地 HTTP 模拟服务，桌宠 UI 效果仍需在运行中的 At-Pet 上确认。

卸载：

```powershell
codex plugin remove codex-at-pet@at-pet-local
codex plugin marketplace remove at-pet-local
```

## 协议参考

- [At-Pet HTTP API 与集成说明](https://github.com/At-PetAdmin/At-Pet/blob/main/README_CN.md)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI 插件打包与本地 marketplace](https://developers.openai.com/plugins/build/plugins)

MIT 许可；上游许可与来源见 `THIRD_PARTY_NOTICES.md`。
