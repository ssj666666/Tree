# Tree · 第 2 步改动记录（2026-11-15，代码部分）

目标：正式登录（自己的账号密码）+ 搜索机器人（博查搜索 API）。只做这两件。
**不做**：语音、部署、推代码、要任何密钥。原项目 `~/workspace/projects/grokbot-clone` 一个字没动（git status 干净）。

## 改了哪些文件

### 1. 正式登录（单管理员，账号密码存在环境变量里）

| 文件 | 改了什么 |
|---|---|
| `server/src/lib/password.ts`（新增） | 密码哈希/校验：Node 自带 `crypto.scrypt`（N=16384, r=8, p=1，64 字节），没装新依赖。存的格式是 `scrypt$<盐>$<哈希>`，校验用 `timingSafeEqual`（恒定时间比较，防止计时攻击）。 |
| `bin/set-admin-password.mjs`（新增） | 生成哈希的小脚本：`node bin/set-admin-password.mjs` 会隐藏输入、让输两次密码，打印出 `TREE_ADMIN_USER` / `TREE_ADMIN_PASSWORD_HASH` 两行，复制进 `.env` 即可；也可以 `node bin/set-admin-password.mjs <密码>` 非交互生成（会进 shell 历史，不推荐）。脚本本身不保存密码。 |
| `server/src/env.ts` | 新增 `adminUser`（`TREE_ADMIN_USER`，默认 `tree`）、`adminPasswordHash`（`TREE_ADMIN_PASSWORD_HASH`，空 = 未配置）、`bochaKey`（`BOCHA_API_KEY`，空 = 未配置）。 |
| `server/src/routes.ts` | 新增 `POST /api/auth/login`：收 `{username, password}`。没配哈希时返回 503 `admin_login_not_configured`（并告诉怎么配）；用户名或密码错都返回同一个 401 `invalid credentials`，不提示是哪一个错；对了就复用现有的 `createSession` 发 `tree_session` Cookie，并用 `findOrCreateUser('admin@tree.local', ...)` 建/取管理员账号。Google 登录保持 410 停用，没接回来。 |
| `web/src/lib/api.ts` | 新增 `api.login(username, password)`。 |
| `web/src/components/SignIn.tsx` | 登录表单换成用户名 + 密码（默认）；`DEV_LOGIN=1` 时仍保留开发邮箱登录入口（点“Use dev email sign-in instead”展开，本地测试用）。 |
| `.env.example` | 加上 `TREE_ADMIN_USER` / `TREE_ADMIN_PASSWORD_HASH` / `BOCHA_API_KEY` 的说明（只留占位，不留真值）。 |

**登录怎么用（给用户）：**
1. 在项目目录跑 `node bin/set-admin-password.mjs`，按提示输两次密码。
2. 把打印出的两行贴进 `.env`（`TREE_ADMIN_USER=tree` 和 `TREE_ADMIN_PASSWORD_HASH=scrypt$...`）。
3. 重启服务器，用用户名 + 密码登录。密码本身只存在用户脑子里和这一个哈希里。

### 2. 搜索机器人（博查搜索 API）

| 文件 | 改了什么 |
|---|---|
| `server/src/agent/websearch.ts`（新增） | 博查客户端：`POST https://api.bochaai.com/v1/web-search`，请求头 `Authorization: Bearer <BOCHA_API_KEY>`，请求体 `{query, count}`。返回标题 + 链接 + 摘要，最多 5 条、每条摘要最多 200 字。**这个函数永远不抛错**：没配 key、网络失败、key 被拒（401/403）、返回读不懂，都会变成一句简短的中文提示返回，对话不会崩。 |
| `server/src/agent/tools.ts` | 新增 `web_search` 工具（所有机器人共用）：参数 `query`（必填）、`count`（1–5，默认 5）；活动类型 `searching_web`。注意：第 1 步在 `loop.ts` 里删掉的是 DeepSeek 没有的**内置** `web_search` / `x_search`，这次加的是我们自己的工具函数，走博查接口，两回事。 |
| `server/src/agent/prompt.ts` | 系统提示词加了一条：不知道的最新信息用 `web_search` 查并附来源链接；工具说没配置时直接告诉用户，不要猜。 |
| `server/src/routes.ts` | `findOrCreateUser` 里新用户建好 Quinn 的同时，也建一个搜索机器人 **Scout**（label: Search）：指令写明“需要联网查的最新信息用 web_search，附来源链接；查不到就直说，不要编”。所有机器人共用同一套工具列表，所以 Scout 的分工就靠这段指令定义。 |

**搜索工具的行为：**
- 配了 `BOCHA_API_KEY`：调博查接口，返回最多 5 条标题 + 链接 + 摘要（已截断，省 token）。
- 没配 key：工具返回“搜索未配置，请先配 BOCHA_API_KEY”的明确提示，机器人会如实转告用户，不会编结果。
- 有 key 但 key 错了 / 网络不通：同样返回一句话说明，不抛错、不崩对话。

## 验证结果（2026-11-15，在这台开发机上）

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（服务端 + 前端） | ✅ 通过 |
| `npm run build`（Vite 前端 + tsc 服务端） | ✅ 通过 |
| 启动服务器（`DEV_LOGIN=1` + 命令行传入的测试管理员哈希） | ✅ 正常启动，`[tree] server on http://localhost:8787 (model deepseek-flash)` |
| 正式登录：错密码 | ✅ 401 |
| 正式登录：错用户名 | ✅ 401（和错密码返回一样，不透露是哪一个错） |
| 正式登录：对的用户名 + 密码 | ✅ 200，拿到会话；机器人列表里同时有 Quinn（Chief of Staff）和 Scout（Search） |
| 开发登录（`DEV_LOGIN=1`） | ✅ 仍可用 |
| Google 登录 | ✅ 仍是 410 |
| 没配 `BOCHA_API_KEY` 时 Quinn 用 `web_search` | ✅ 调了两次工具，都返回“未配置”提示；Quinn 如实告诉用户查不到、不会瞎编，对话没崩（它顺手试的浏览器/shell 备用路因 Orgo 未配置报错，也如实说了） |
| 没配 `BOCHA_API_KEY` 时 Scout 用 `web_search` | ✅ 同样调了工具、如实报告未配置，并给了两个解决办法（配 key / 用浏览器查） |
| 原项目 `~/workspace/projects/grokbot-clone` | ✅ `git status` 干净，一个字没动 |
| `.env` 里的 `DEEPSEEK_API_KEY` 替身值 | ✅ 没动（仍是 `hsurr:` 开头） |

**验证用的测试密码**是 `tree-test-pw-2026`，只通过命令行环境变量传给测试那一次服务器进程，**没有写进 `.env` 或任何文件**；测试完服务器已停，测试数据库（`data/`）、cookie、日志已删干净，用户首次登录是全新状态。

## 还缺什么（第 2 步以外，不要在这一步做）

- **BOCHA_API_KEY**：用户要去博查官网注册拿 key（36 元/1000 次），填进 `.env` 再重启服务器，搜索才真正能查。没 key 时搜索功能只会如实说“未配置”。
- **管理员密码**：用户自己跑 `bin/set-admin-password.mjs` 生成哈希、填进 `.env` 再重启。没配之前正式登录返回 503，开发登录仍可用。
- **语音**：国内 ASR → DeepSeek → TTS 方案还没接，语音接口仍是 503 stub。
- **部署**：还没部署到阿里云轻量服务器（用户已买，3Mbps 带宽，够用）。
- **git remote**：还指向上游 `nickvasilescu/grokbot-clone`，推代码之前要先改成用户自己的仓库再 push，**不要直接往上游推**。
- **前端登录页**：已改成用户名 + 密码表单，但这次只在服务端接口层面验证了登录流程，没有在浏览器里点一遍表单（开发机上没有配好的浏览器会话）；部署后第一次在浏览器打开时顺手点一次即可。
