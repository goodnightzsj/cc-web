# cc-web 部署快照

> 本文件由自驱动优化 loop 在收敛后产出，记录当前生产部署形态、资源指纹机制、缓存策略、以及历轮优化清单。可作为新机器复刻或后续维护的起点。

部署位置：`23.80.89.173:443` → `cc.9962510.xyz`（公网入口），HEAD `77fa224`。

---

## 1. 服务架构

```
┌──────────────┐  HTTPS  ┌─────────────────────┐  HTTP   ┌──────────────────┐
│  浏览器/用户  │ ──────▶│ Cloudflare 边缘     │ ──────▶ │ 23.80.89.173:443 │
└──────────────┘  cf-tls  │ (橙云代理 + mTLS    │  origin │ nginx 1.24       │
                          │  origin pull cert)  │  pull   │ - mTLS 客户端验证 │
                          └─────────────────────┘         │ - IP 白名单       │
                                                          │ - fail2ban 4 jail │
                                                          │ - rate limit      │
                                                          └────────┬─────────┘
                                                                   │ proxy_pass
                                                                   │ + WS Upgrade
                                                                   ▼
                                                          ┌──────────────────┐
                                                          │ Node.js v24      │
                                                          │ server.js :8003  │
                                                          │ (systemd unit)   │
                                                          └────────┬─────────┘
                                                                   │ spawn (detached)
                                                                   │ stdio: [pipe, file, pipe]
                                                                   ▼
                                                          ┌──────────────────┐
                                                          │ claude / codex   │
                                                          │ CLI 子进程        │
                                                          │ (stdout=output.jsonl
                                                          │  stderr=tee→ws + 文件)
                                                          └──────────────────┘
```

四层防护链（任一层放行才能到下一层）：

1. **CF 边缘**：DNS 橙云、WAF、bot 防护；CNAME `cc.9962510.xyz` → `23.80.89.173`
2. **nginx mTLS（AOP）**：`ssl_verify_client on` + `cloudflare-origin-pull-ca.pem`，确保只接受 CF 回源（直接打 23.80.89.173:443 会 400）
3. **IP 白名单**：`include snippets/whitelist-access.conf` — geo $allowed_ip 非白名单 403
4. **cc-web 自带密码**：32 位随机 `CC_WEB_PASSWORD`，WebSocket auth 失败计数（5 次/10min 即 IP 封）
5. **fail2ban 兜底**：`cc.9962510.access.log` 已加入 `nginx-whitelist-deny` / `nginx-login-401` / `nginx-sub2api-scan` / `nginx-sub2api-404`

---

## 2. 资源指纹（hash）机制

为让 CF + 浏览器缓存稳定生效又不卡住更新，所有大体积静态资产走"内容寻址 + 永久缓存"策略，其余走短缓存兜底。

### 流水线（每次部署执行）

`scripts/build-assets.js` 在 `bash scripts/deploy.sh` 内被首先调用：

1. 读取 `public/app.js` 与 `public/style.css`
2. 计算 `sha256(content)[:10]`（hex，10 字符）
3. 写出 `public/app.<hash>.js` / `public/style.<hash>.css`（与源文件并存，源文件用于本地 dev）
4. 删除上一轮产出但与当前 hash 不一致的旧 `*.<10hex>.{js,css}`（保留当前一份）
5. 用正则 `(href|src)="(app|style)(\.[0-9a-f]{10})?\.(js|css)"` 重写 `public/index.html` 引用为最新 hashed 文件名

### 三档 Cache-Control（server.js 静态文件处理器决定，nginx 透传）

| 资源 | Cache-Control | 含义 |
|---|---|---|
| `*.<10hex>.{js,css}` | `public, max-age=31536000, immutable` | 内容变了文件名一定变，CF + 浏览器永久缓存 |
| `index.html` / `sw.js` | `no-cache, must-revalidate` | 入口文件，每次请求都向 origin 校验（带 ETag） |
| 其它（png/svg/woff/...） | `public, max-age=300` | 5 分钟兜底，避免长缓存阻塞 favicon/icon 更新 |

### nginx 与 upstream 的分工

`/etc/nginx/sites/cc.9962510.xyz.conf` 内对静态资产 location 不再 `expires/add_header`，**信任 upstream 下发的 Cache-Control**：

```nginx
# hashed 资源（优先匹配）
location ~* "\.[0-9a-f]{10}\.(?:js|css)$" {
    proxy_pass http://app_cc;
    # 透传 upstream Cache-Control: public, max-age=31536000, immutable
    access_log off;
}
# 其它非 hashed 静态
location ~* \.(js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico|map)$ {
    proxy_pass http://app_cc;
    # 透传 upstream（sw.js→no-cache，其它→max-age=300）
    access_log off;
}
```

这样资源只在 server.js 一处定义缓存策略，nginx + CF 自动跟随。

---

## 3. 缓存交互（CF ↔ nginx ↔ origin）

1. **首次访问 `https://cc.9962510.xyz/`**：CF miss → 回源到 nginx → proxy 到 :8003 → 返回 `index.html` + `Cache-Control: no-cache`。CF 不缓存，浏览器每次必须校验。
2. **`index.html` 内嵌引用 `app.<hash>.js`**：浏览器请求该 URL。CF miss → 回源 → nginx → :8003 → 返回 + `Cache-Control: public, max-age=31536000, immutable`。CF 把它放入边缘缓存。
3. **同一 URL 再次被任何用户访问**：CF hit，0ms 命中，origin 完全不感知。一年内不会回源。
4. **每次部署的 hash 变化**：`scripts/deploy.sh` 重新算 hash 后，新文件名 = `app.<new_hash>.js`，CF 边缘对它仍然 miss → 回源 → 拉新版 → 进入缓存。**旧 hash URL 仍然有效**（旧文件还在 public/），但 `index.html` 已只引用新版。
5. **不需要 CF Purge**：因为 URL 是内容寻址的，URL 不变 = 内容不变；URL 一变 = 已是新缓存条目，旧的过期自然淘汰。

WebSocket（`/`）走 `proxy_buffering off` + 3600s 超时，不进入缓存路径。

---

## 4. 每次部署的标准动作

```bash
bash /root/cc-web/scripts/deploy.sh
```

等价于以下步骤（任一失败就中止并 dump systemd 状态）：

1. **`node scripts/build-assets.js`** — 给 `app.js` / `style.css` 生成最新 sha256[:10] hashed 文件、清旧、重写 `index.html` 引用
2. **`systemctl restart cc-web.service`** — 重启 Node 后端（systemd `KillMode=process` 只杀 node，不杀 claude/codex 子进程，断线重挂载）
3. **健康检查**：循环 20 次（每次 0.5s）`curl http://127.0.0.1:8003/`，等 200
4. **冒烟**：对一个 hashed 资源 + `index.html` 各 `curl -I` 一次，打印 Cache-Control（人工可验证三档策略生效）

特殊情况：

- **改了 nginx 配置**：需手动 `nginx -t && systemctl reload nginx`（deploy.sh 不动 nginx）
- **改了 systemd unit**：需手动 `systemctl daemon-reload && systemctl restart cc-web`

---

## 5. systemd 单元要点

文件：`/etc/systemd/system/cc-web.service`

| 配置 | 值/含义 |
|---|---|
| `User=root` | 子进程能访问 `/root/.claude` `/root/.codex` |
| `KillMode=process` | 仅 SIGTERM Node，**不杀 claude/codex 子进程**（README 强制） |
| `ProtectHome=read-only` + `ReadWritePaths=` | 写盘限定在 `/root/cc-web /root/.claude /root/.codex /root/.cache /tmp` |
| `SystemCallFilter=@system-service @resources @keyring` | 允许 prctl/setrlimit/prlimit64（claude 子进程需要，否则 SIGSYS） |
| `MemoryMax=1G` `TasksMax=300` `CPUQuota=200%` | 资源上限 |
| **不能加** `MemoryDenyWriteExecute=true` | V8 JIT 需 RWX 内存 |
| **不能加** `IPAddressDeny=any` | claude/codex 需联网调 Anthropic/OpenAI |
| `Environment=IS_SANDBOX=1` | 告诉 claude CLI 当前已被 systemd hardening，禁用其内部 sandbox 检测 |

---

## 6. 本次 loop 完成的优化清单

8 次提交，覆盖"事件透传"、"信息完整性"、"基础设施"三类。所有改动通过 deploy.sh 重新 hash 入仓。

| 提交 | 范围 | 关键收益 |
|---|---|---|
| `8e654a5` | extended thinking + TodoWrite + asset hash | Claude `thinking` 块端到端 → `thinking_delta` 折叠引用块；TodoWrite/update_plan → ✓/◐/○ 进度卡片 + 进度条；scripts/build-assets.js + deploy.sh + 三档 Cache-Control 基础设施 |
| `8bef1ab` | tool_result 64KB + is_error + 内联图片 | `.slice(0,2000)` 升级到 64KB；解析数组 content（text/image/nested tool_use）；Codex `exit_code !== 0` → isError；base64 image gallery；截断 banner（"已显示 X / 共 Y"） |
| `7000f54` | stderr 流路由 | spawn stdio 改 pipe；tee 到 error.log 兼容退出后读；节流 200ms 合并 `stderr_chunk` 事件；前端 `<details>` 折叠面板；过滤 Reconnecting/ANSI 噪声 |
| `d91e083` | Edit/Write/MultiEdit 双栏 diff | 修复 **`sanitizeToolInput` 硬 bug**（`truncateObj(parsed,500)` 把 Edit 入参全废）→ per-tool 白名单 + 8KB 字段封顶；Claude file 工具注入 `file_change` kind；`extractDiffHunks` 识别 4 种 Claude 形态 + Codex `changes`；红/绿 grid（≤720px 改纵向） |
| `317837f` | Claude system.subtype 透传 | `init` 子类型 → "Claude Code 已就绪 · model\ncwd\nN tools · M MCP servers · mode" banner；`compact_summary` → "187K → 24K tokens（节省 87%）" 量化反馈；`error` 子类型；前端 `data-kind` 路由 3 套 CSS |
| `77fa224` | Claude usage 双轨 + Codex item.failed + result error | Claude `result.usage` 累加到 session.totalUsage → 与 Codex `in/out/cache · $cost` 头部对齐；`result.subtype !== 'success'` 终止子类型透传；新 case `item.failed` 修 Codex MCP/file_change/command 失败时 spinner 永远转的 bug |

### 已识别但不予实施（ROI 不达标）

- 代码高亮主题跟随 site 主题切换（纯美学）
- token 速率指示器 tok/s（已有 totalUsage chip）
- 图片 lightbox 放大（锦上添花）
- 会话导出 markdown（独立功能 >100 行）
- stderr 时间戳/分段（边际）
- Edit diff 行级 LCS 高亮（整段对比已够用）

---

## 7. 已知约束 / 注意事项

- `mtls + 白名单 + 密码 + fail2ban` 四层防护任一降级都 = 公网 RCE，**绝对不能关**
- `KillMode=process` 必须保留（README 强制）
- 不要给 cc-web 容器化（systemd 模型已和 KillMode=process 深度耦合）
- 不要把 8003 改成 `0.0.0.0` 监听
- nginx 1.24 用 `listen 443 ssl http2;` 旧式语法（`http2 on;` 是 1.25+）
- 上游：`upstream = ZgDaniel/cc-web`，origin = `goodnightzsj/cc-web`（本次 loop 所有改动 push 到此 fork）
