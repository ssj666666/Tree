# Tree · 第 1 步改动记录（2026-11-15）

目标：把 `grokbot-clone` 改成用户自己的国内版个人智能体 **Tree**，模型换 DeepSeek V4.1 Flash，
只要文字聊天能跑。原项目 `~/workspace/projects/grokbot-clone` 一个字没动（git status 干净）。

## 改了哪些文件（共 36 个）

### 改名 Tree
| 文件 | 改了什么 |
|---|---|
| `package.json` | `name`: grokbot → `tree`；描述改写 |
| `server/package.json` | `@grokbot/server` → `@tree/server` |
| `web/package.json` | `@grokbot/web` → `@tree/web` |
| `web/index.html` | 页面标题 Grokbot → `Tree` |
| `web/public/favicon.svg` | 原来是绿底白字 "GD"，换成绿底白色小树图形 |
| `web/src/components/SignIn.tsx` | 标题 Grokbot → `Tree`；Google 登录按钮已删（见登录一节）；页脚改成 "Tree — your personal agent team. Not affiliated with xAI or Grok." |
| `README.md`、`assets/readme-banner.svg` | 标题/说明改成 Tree + DeepSeek；保留一行 "Inspired by Grok Bot" 的来源致谢 |
| `server/src/agent/prompt.ts` | 系统提示词里的 "Grokbot team" → "Tree team" |
| `web/src/App.tsx`、`web/src/store.ts`、`web/src/configStore.ts`、`web/src/lib/api.ts`、`web/src/components/DetailsPanel.tsx`、`web/src/components/modals/ConnectAppsModal.tsx`、`server/src/routes.ts` | localStorage 键名前缀 `grokbot.` → `tree.`；跨窗口事件名 `grokbot-connected` / `grokbot:event` → `tree-…` |
| `server/src/lib/auth.ts` | Cookie 名 `grokbot_session` → `tree_session`（旧登录态会失效，需重新登录） |
| `server/src/agent/tools.ts`、`server/src/computer.ts`、`server/src/routes-config.ts`、`web/src/components/config/LibraryTab.tsx` | 云电脑上的路径 `/root/grokbot/…` → `/root/tree/…`；电脑名 `grokbot-…` → `tree-…` |
| `web/src/components/ChatView.tsx` | "Sharing isn't available in Grokbot yet" → "…in Tree yet" |

### 换模型：xAI Grok → DeepSeek V4.1 Flash
| 文件 | 改了什么 |
|---|---|
| `server/src/env.ts` | 唯一必填项改成 `DEEPSEEK_API_KEY`；模型 `deepseekModel`，默认 `deepseek-flash`（现行 API ID，不要写 `deepseek-v4.1-flash`）；`COMPOSIO_API_KEY`、`ORGO_API_KEY` 改成可选（空字符串）；`SESSION_SECRET` 改成可选（有默认值，第 1 步用不上）；数据库路径 `data/grokbot.db` → `data/tree.db` |
| `server/src/agent/loop.ts` | 客户端 `baseURL` 由 `https://api.x.ai/v1` → `https://api.deepseek.com/v1`，模型 `env.deepseekModel`；删掉了 xAI 专属字段 `reasoning.effort`、`include: reasoning.encrypted_content`、`prompt_cache_key`、`safety_identifier`（DeepSeek 会拒掉）；工具列表删掉了 DeepSeek 没有的内置 `web_search` / `x_search`（联网搜索第 2 步用博查接回来）；400 重试时也只用自有工具 |
| `server/src/agent/memory.ts` | 同样换成 DeepSeek 客户端；**删掉了 xAI 专属的 `POST /responses/compact` 压缩接口**——DeepSeek 没有这个接口，历史压缩现在一律走纯文本摘要（summary）；长期记忆整理（consolidation）去掉 `reasoning` 和 `text.format: json_schema`（DeepSeek 的 Responses API 不支持），改成让模型直接返回 JSON 文本再宽松解析；环境变量前缀 `GROKBOT_COMPACT_*` → `TREE_COMPACT_*` |
| `server/src/index.ts` | `/api/health` 返回的模型名改成 `deepseek-flash`；日志前缀 `[grokbot]` → `[tree]`；`GROKBOT_NO_SCHEDULER` → `TREE_NO_SCHEDULER` |
| `server/src/idle.ts` | 环境变量前缀 `GROKBOT_IDLE_*` → `TREE_IDLE_*` |
| `.env.example`、`.env` | 重写：只需要填 `DEEPSEEK_API_KEY` + `DEV_LOGIN=1`；COMPOSIO / ORGO 留空即禁用；语音一节注明第 1 步已禁用 |

### 去掉海外依赖（没配也能启动）
| 文件 | 改了什么 |
|---|---|
| `server/src/composio.ts` | **原来 `new Composio({apiKey: ''})` 在模块加载时就直接抛错**，改成懒加载：只在真正要用、且配了 key 时才创建客户端；没配 key 时 `catalog()` 返回空列表，`composioTools()` 返回空列表（机器人对话不受影响）；新增 `getComposio()` / `composioEnabled()` |
| `server/src/triggers.ts` | 改用懒加载的客户端；没配 Composio 时跳过事件订阅，不报错 |
| `server/src/routes.ts` | `/auth/google/start` 与 `/auth/google/callback` 改成返回 410 `google_login_disabled`（Google 登录走 Composio + Gmail，是海外服务）；登录只留开发模式邮箱登录（`POST /api/auth/dev`，`DEV_LOGIN=1`，第 1 步够用，正式登录第 2 步再做） |
| `server/src/voice.ts` | **整个文件换成 stub**：原来 456 行全是 xAI 实时语音（realtime / TTS / STT），DeepSeek 没有对应的实时语音服务；现在所有 `/api/voice/*` 请求都返回 503 `voice_disabled`，并说明第 1 步只要文字版 |
| `web/src/components/Composer.tsx` | 输入框的语音通话按钮、听写（dictation）麦克风按钮都置灰禁用（点不通，不如直接不让点） |
| `web/src/components/VoiceSettings.tsx` | 语音设置面板里的试听（Preview）和开始通话按钮都置灰禁用；语音/语速/语言的选择框还留着（只是保存设置，不影响运行） |

### 没改的地方（有意留下的）
- `docs/` 里的逆向工程文档、`server/src/agent/rooms.ts`、`subagents.ts`、`proactive.ts` 头部的注释还提 Grok Bot——那是"原来这个功能是从哪抄来的"开发笔记，不是用户界面，留着方便以后对照。
- `web/src/voice/`（浏览器端通话代码）整个文件夹没动：服务端已禁用，它跑不到，国内语音方案第 2 步再整体换掉。
- `git remote` 还指向上游 `nickvasilescu/grokbot-clone`：第 2 步推代码之前，要先改成用户自己的仓库再 push，**不要直接往上游推**。

## 验证结果（2026-11-15，在这台开发机上）

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（服务端 + 前端） | ✅ 通过 |
| `npm run build`（Vite 前端 + tsc 服务端） | ✅ 通过，`web/dist/index.html`、`server/dist/index.js` 已生成 |
| 不配任何 key 启动 | ✅ 只报 `Error: Missing env DEEPSEEK_API_KEY`，不再出现 XAI / COMPOSIO / ORGO 的报错 |
| 配一个假的 `DEEPSEEK_API_KEY` + `DEV_LOGIN=1` 启动 | ✅ 正常启动，日志 `[tree] server on http://localhost:8899 (model deepseek-flash)` |
| `GET /api/health` | ✅ `{"ok":true,"model":"deepseek-flash"}` |
| 打开首页 | ✅ `<title>Tree</title>`，前端正常 served |
| 邮箱开发登录（`POST /api/auth/dev`） | ✅ 成功，自动建好主机器人 Quinn |
| `GET /api/apps`（应用市场） | ✅ 返回空列表，没配 Composio 也不崩 |
| `GET /api/auth/google/start` | ✅ 410 `google_login_disabled` |
| `GET /api/voice/options`（已登录） | ✅ 503 `voice_disabled` |
| 发一句话给 Quinn（假 key） | ✅ 机器人进入 thinking，调用了 `api.deepseek.com`，DeepSeek 返回 401（假 key 无效），界面上正常显示一条错误提示，服务器没崩 |
| 原项目 `~/workspace/projects/grokbot-clone` | ✅ `git status` 干净，一个字没动 |

补充说明：
- 中间有一次 `curl api.deepseek.com` 在 TLS 握手阶段卡住超过 15 秒，第二次 0.5 秒就通了——是这台开发机出口代理的偶发抖动，不是代码问题；最终机器人那次调用也正常走到了 DeepSeek 并拿到了 401。
- **真 key 的完整对话还没验证**：假 key 只能验证到"调到了 DeepSeek、报错正常"这一步。拿到真 key 后，同一句话应该直接得到 DeepSeek 的回答。

## 真钥匙完整对话验证（2026-11-15 16:47，补充）

- 用户在安全页面提交了 DeepSeek API 密钥，存在连接 `custom.deepseek` 里，真实密钥不可读；每次用之前用 `bin/refresh-deepseek-key.py` 从 authd 取一个 `hsurr:*` 替身（Surrogate，临时替身凭证）写进 `.env` 的 `DEEPSEEK_API_KEY`，出口处由 Sentinel 换成真钥匙。
- 直接调 DeepSeek Responses API 冒烟测试：`deepseek-flash` 正常回话（第一次调因出口代理抖动超时 60 秒，重试 2.5 秒就通）。
- 端到端测试：启动 Tree 服务器（端口 8787），开发模式邮箱登录，主机器人 Quinn 收到测试消息后，**用 DeepSeek 真钥匙回了中文自我介绍**，还顺手调了 `remember` 工具记下“用户叫树杰，用中文交流，回复简短直接”。第 1 步至此全部验证通过。
- 测试完服务器已停，测试数据库、cookie、日志已删干净，用户首次登录是全新状态。`.env` 里留的是替身值，下次启动前先跑 `bin/refresh-deepseek-key.py` 刷新。

## 还需要什么（第 1 步以外）
- **DEEPSEEK_API_KEY**：用户提供，走安全填写，绝不发聊天里、不写进代码。填到 `~/workspace/projects/tree/.env` 里，重启服务器即可。
- 测试用的数据库、cookie、日志已删干净（`data/` 已删除），用户第一次登录会是全新状态。

## 第 2 步待做的事（不要在第 1 步里做）
1. 用真 key 跑通一次完整对话，确认 DeepSeek 文字版真的能回话。
2. 正式登录：把开发模式邮箱登录换成自己的账号密码登录（Google 登录不接回来）。
3. 语音：国内 ASR → DeepSeek → TTS 方案接回来（阿里云 Qwen3-ASR / Qwen3-TTS 之前已调研过），替换掉现在的语音 stub 和浏览器端通话代码。
4. 搜索机器人：接博查搜索 API（Bocha，36 元/1000 次），补回第 1 步拿掉的联网搜索。
5. 把 git remote 改成用户自己的仓库，再推代码；之后部署到阿里云轻量服务器（按已写好的 ECS 下单检查清单买）。
