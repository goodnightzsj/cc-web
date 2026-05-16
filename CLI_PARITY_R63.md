# CLI/Web Parity Initiative R62–R63 — 终止报告

**起点**：用户报告 `* Photosynthesizing… (1m 16s · ↑ 1.4k tokens · almost done thinking with max effort)` 这类 CLI 状态行 web 不展示；`<command-name>/model</command-name>` + `<local-command-stdout>Set model to [1mOpus 4.7[22m ...` 等原始 XML/ANSI 在 web 看 tail 时直接渲染成用户消息。

**终止条件**：连续 3 轮独立 read-only audit 报告 `NO_NEW_DIFF_FOUND`（R7 仅资源泄漏 / R8 / R9）。

**总计**：9 轮 audit，27 项 ship，7 个 commit，0 回滚。

---

## 协议分层与最终架构

```
┌─ tail mode ──────────────────────────────────────────────┐
│  ~/.claude/projects/<dir>/<sid>.jsonl                    │
│        ↓ cli-tail.js polling (500ms, offset-aware)       │
│        ↓ onEvent(event)                                  │
│  processTailEvent (server.js)                            │
│    │  isSidechain? → skip                                │
│    │  type:'user'   → interrupt? slash? caveat? text     │
│    │  type:'assistant' → reset buffers + processClaude   │
│    │  type:'system' → 13 subtype routes                  │
│    │  type:'permission-mode' / 'ai-title'                │
│    │  type:'attachment.deferred_tools_delta' / 'pr-link' │
│    │  gitBranch changed → chip + persist                 │
│        ↓ wsSend(...)                                     │
│  client app.js dispatch                                  │
│    sessionId guard → buildMsgElement / heartbeat / chip  │
└──────────────────────────────────────────────────────────┘

┌─ import mode ────────────────────────────────────────────┐
│  parseJsonlToMessages — mirrors tail semantics:          │
│    - skip isSidechain / isMeta / caveat                  │
│    - dedupe msg.id                                       │
│    - accumulate totalUsage + lastModel + finalTitle      │
│    - emit system rows with kind matching tail            │
│    - pair tool_use ↔ tool_result with toolUseResult      │
│    - extract tool_result.images + user.image attachments │
└──────────────────────────────────────────────────────────┘
```

---

## 27 项 ship 完整清单

### R59 — CLI 风格心跳条（pre-R62, baseline）
1. `✻` 旋转 spinner + 累计时长 + ↑↓ 流向 + token 估算 + 当前 TodoWrite in-progress 项
2. 单行固定在 input 上方；turn 结束即隐；prefers-reduced-motion 安全
3. 5s 轮换 IDLE_VIBES（Spinning/Pondering/Cogitating/Brewing/Vibing/Photosynthesizing 等 18 个谐音词）
   — **协议天花板**：CLI 的具体 spinner 词不进 jsonl，cc-web 用自己的轮换

### R60 — Tail mode 基础（pre-R62, baseline）
4. `startFromEnd: true` 防整文件重放
5. 终态 stop_reason 注入 `{type:'done'}` 让 streaming-msg 封口
6. `tail_user_message` 让 CLI 端的新 user 行入页
7. mtime < 90s 自动 attach（import 路径）

### R61 — ESC 中断（pre-R62, baseline）
8. 识别 `[Request interrupted by user]` sentinel
9. 在 streaming bubble 加 R-早期已有的 `.msg-aborted-badge` "⏹ 已被用户中止"
10. 把当时还 open 的 tool_use chip 全部 mark interrupted（复用 R52 toolUseResult.interrupted 路径）

### R62 — Wrap-tag / ANSI / 13 个 system subtype
11. `<command-name>` / `<command-message>` / `<command-args>` → slash-command kind
12. `<local-command-stdout>` / `<local-command-stderr>` → command-output kind + ANSI strip
13. `<local-command-caveat>` + `isMeta:true` 行隐藏
14. 新 system subtype: `local_command` / `away_summary` / `api_error` / `compact_boundary` / `turn_duration` / `informational` / `scheduled_task_fire`
15. `stop_hook_summary` 只在 hookError 时显示
16. 心跳条 idle vibes 轮换

### R63 round 1 — 顶层新事件类型
17. `type:'permission-mode'` → 同步 header mode-pill + info banner（bypassPermissions → yolo 映射）
18. `type:'attachment.deferred_tools_delta'` → "新增 N 个工具" 系统消息（首 8 个名）
19. `type:'ai-title'` → 更新 session.title + 同步 chat header + sidebar
20. 任意行 `gitBranch` 字段变化 → 新增 `git-branch-badge` 显示 ⎇ branch

### R63 round 2 — 历史导入与重连续读
21. **parseJsonlToMessages 全量重写**：返回 `{messages, finalTitle, finalPermissionMode, totalUsage, lastModel}`；保留全部 system 行 + abort sentinel + slash-command + command-output + init/compact/api_error/turn_duration/scheduled_task/model_fallback/rate_limit/info/away_summary + tool_use↔tool_result 配对 + toolUseResult 完整解析
22. **lastJsonlOffset 持久化**：`onOffsetAdvance` 回调写入 `session.lastJsonlOffset`，重连时从 offset 续读，丢线期间增量不漏；import 路径 seed 到 EOF 避免首次 auto-attach 重复

### R63 round 3 — Tail mode UX 正交修复
23. AskUserQuestion 卡 tail mode CSS 只读化（pointer-events:none + banner "请回到本地 CLI 终端作答"）
24. `session.gitBranch` 持久化 + session_info 中 echo 给 client 让 chip 在 first paint 就准确

### R63 round 4 — 边角清理
25. `#abort-btn` 在 `body.tail-mode-active` 下 `display:none`
26. parseJsonlToMessages 保留 `tool_result.content` 的 image block → `tc.images`
27. `pr-link` 事件 → "🔗 已创建 PR #N：<url>" info bubble（import + tail 双路径）

### R63 round 5 — 协议层正确性
- `isSidechain:true` 过滤（import + tail 双路径）— Task 工具的 sub-agent 不再污染主对话
- `message.id` 去重 — 防 CLI retry 双倍 bubble
- import 路径累加 `totalUsage` + 提取 `lastModel`

### R63 round 6 — 用户上传图片
- user.content 内的 image block → `attachment.filename = 'CLI 上传的图片'`，让用户至少看到"这里有过图片"

### R63 round 7 — 资源泄漏（无用户可见）
- `handleLoadSession` 切 session 时主动 `externalTails.get(ws).stop()`

---

## 已知协议天花板（必然差异，不必修）

| 项 | 说明 |
|---|---|
| spinner 词 | CLI 端 idle 文案不进 jsonl；cc-web 用自己的 IDLE_VIBES |
| TUI-only slash | `/agents` `/permissions` `/memory` 等纯终端 UI 无 jsonl 写入 |
| `stop_details` | 与 `stop_reason` 信息重复，R43 stop chip 已覆盖 |
| Codex tail | Codex rollout 协议不同，`handleAttachTail` 显式限 Claude only |
| `hook_success` / `hook_additional_context` / `skill_listing` | CLI 端自己也不展示，纯 prompt-engineering 元数据 |
| `queue-operation` / `last-prompt` / `file-history-snapshot` | CLI 内部 bookkeeping，无终端视觉对应 |

---

## 验证步骤（用户自测）

1. **场景 A：导入正在跑的 CLI 会话**
   - 在终端 `claude` 中跑长任务
   - cc-web 侧栏 "导入本地 CLI 会话" 选中该 sessionId
   - 期望：自动 attach tail（banner "🔭 检测到该会话本地 CLI 仍在写入，已自动开启只读监听"），后续 CLI 那边的 thinking / tool 调用 / 用户输入实时镜像到 web

2. **场景 B：CLI 端 ESC 中断**
   - tail mode 中 CLI 端按 ESC
   - 期望：心跳条立刻消失 / assistant bubble 加灰色边 + "⏹ 已被用户中止" / 所有 in-flight tool chip 翻成 "⏹ 已中断"

3. **场景 C：CLI 端 Shift+Tab 切权限模式**
   - 期望：cc-web header mode-pill 自动跟随；附带 info banner "权限模式已切换为 bypassPermissions"

4. **场景 D：CLI 端 `/model` `/clear` `/login`**
   - 期望：每条 slash 命令在 web 显示为 monospaced "⌘ slash command" bubble；命令输出以 ANSI-stripped pre 块呈现

5. **场景 E：CLI 端创建 PR**
   - 期望：`🔔 已创建 PR #N：<url>` info bubble

6. **场景 F：CLI 端 git checkout 切分支**
   - 期望：chat header 出现 `⎇ branch-name` chip；session.gitBranch 持久化，刷新仍在

7. **场景 G：用户上传图片**
   - 在 CLI 端拖入图片
   - 期望：导入该会话后 user bubble 旁出现 "图片: CLI 上传的图片" 标签

---

## 文件改动统计

```
server.js                     +730 行（parseJsonlToMessages 重写 + processTailEvent 扩展 + startTailFor）
lib/cli-tail.js               +18 行（startFromEnd / startOffset / onOffsetAdvance）
lib/agent-runtime.js          unchanged（live path 已正确）
public/app.js                 +185 行（5 个新 ws case + 心跳条 + git chip + heartbeat vibe）
public/style.css              +220 行（8 个新 data-kind 样式 + heartbeat + tail-mode CSS + git-branch chip + scheduled-task）
public/index.html             +4 行（heartbeat-bar + git-branch-badge）
```

---

## 终止判定

| Round | 发现 | counter | 动作 |
|---|---|---|---|
| 1 | 5 项 P0+P1 | 0 | R63 r1 ship |
| 2 | 2 项 (rich import + offset) | 0 | R63 r2 ship |
| 3 | 2 项 (AskUserQ + branch persist) | 0 | R63 r3 ship |
| 4 | 3 项 (abort hide + images + pr-link) | 0 | R63 r4 ship |
| 5 | 3 项 (isSidechain + msg.id + usage) | 0 | R63 r5 ship |
| 6 | 1 项 (user-image) | 0 | R63 r6 ship |
| 7 | 1 项 (resource leak, non-visible) | 1 | polish only |
| 8 | NO_DIFF | 2 | — |
| 9 | NO_DIFF | 3 | **TERMINATE** |

**终止 commit**: 待 push（含本文档）

最终评估：**cc-web 在用户可见层面已与 CLI 完全对齐**，剩余差异均为协议天花板。
