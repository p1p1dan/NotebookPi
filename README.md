# NotebookPi

单用户在线笔记本。Markdown / 纯文本，多级文件夹，全文搜索，版本历史，Docker 一键部署。

底层是 Node + Fastify + SQLite（FTS5 trigram，对中文友好），前端 Vite + 原生 TS + CodeMirror 6。整个产品是私人用，**不做注册流**，只有一个密码，写在 `.env` 里。

> 仓库：https://github.com/p1p1dan/NotebookPi

---

## 一键部署

```bash
git clone https://github.com/p1p1dan/NotebookPi.git
cd NotebookPi
cp .env.example .env

# 生成两个密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"           # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"     # API_TOKEN（可选）

# 编辑 .env 至少填 NOTEBOOK_PASSWORD 和 SESSION_SECRET
docker compose up -d --build

# 浏览器访问 http://<server>:8454
```

数据持久化在 `./data/notebook.db`（SQLite 单文件），**定期备份这一个目录就够了**。

### .env 字段

| 变量 | 必填 | 说明 |
|---|---|---|
| `NOTEBOOK_PASSWORD` | ✓ | 登录密码 |
| `SESSION_SECRET`    | ✓ | Cookie 签名密钥，≥16 字符 |
| `API_TOKEN`         | ✗ | 设上之后开启 `Authorization: Bearer` 鉴权（AI/脚本用）；≥16 字符 |
| `PORT`              | ✗ | 默认 8454 |
| `COOKIE_SECURE`     | ✗ | `1` = 仅 HTTPS 下发 cookie，反代 + TLS 时设 |

---

## 主要功能

- 三栏布局：文件夹树 / 笔记列表 / 编辑器 + 实时预览
- 每篇笔记可选 **TXT / Markdown** 格式（默认 TXT，更轻、避免符号被识别成格式）
- 多级文件夹，拖拽 `.txt / .md` 文件直接导入到当前文件夹
- 全文搜索（中英文，FTS5 trigram + 短词 LIKE 兜底，命中词 `<mark>` 高亮）
- **版本历史**：每次保存且内容变化时自动留存，每篇最多 50 版可回溯
- **笔记置顶**：置顶笔记在文件夹 / 全部笔记视图中排在最前（搜索结果仍按相关度）
- **分享链接**：为笔记生成只读链接（`/s/<token>`），无需登录即可查看，可随时撤销
- 明 / 暗主题，IME 安全的标题输入，自动保存（停止输入 2 秒）
- 移动端 < 768px 自动单栏堆叠
- 单文件 SQLite，单容器，零外部依赖

---

## API 文档

所有 API 都接受 **两种鉴权**：
- **浏览器**：登录后自动带 cookie
- **脚本 / AI**：`Authorization: Bearer <API_TOKEN>` header（前提 `.env` 设了 `API_TOKEN`）

### ★ 一次性批量导入

`POST /api/import` — 给 AI 用的主要入口。整理好一批文件后一次性提交：

```bash
curl -X POST http://<server>:8454/api/import \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "folder": "工作/2026/Q2",
    "notes": [
      {"title": "周报",     "content": "本周完成...",       "format": "txt"},
      {"title": "设计方案", "content": "# 标题\n\n正文",    "format": "md"},
      {"title": "灵感",     "content": "随手记一段"}
    ]
  }'
```

- `folder`：以 `/` 分隔的路径，逐级查找/创建；省略或空串 = 未归类（根）
- `notes[]`：一次最多 100 篇，每篇 content ≤ 1 MB
- 路径最多 10 级
- 事务保护：要么全部入库，要么全不入

返回：
```json
{
  "folder_id": 4,
  "folder_path": "工作/2026/Q2",
  "count": 3,
  "notes": [ { "id": 17, ... }, ... ]
}
```

### 其他端点速查

| 操作 | 方法 + 路径 | Body / Query |
|---|---|---|
| 列所有文件夹（含 note_count） | `GET  /api/folders` | — |
| 新建文件夹 | `POST /api/folders` | `{ parent_id?, name }` |
| 改名 / 移动 | `PATCH /api/folders/:id` | `{ name?, parent_id? }` |
| 删除（含子文件夹，笔记落到未归类） | `DELETE /api/folders/:id` | — |
| 列笔记（轻量，含 240 字摘要，置顶优先） | `GET  /api/notes` | `?folder_id=<id\|null\|all>` |
| 取笔记完整内容 | `GET  /api/notes/:id` | — |
| 新建笔记 | `POST /api/notes` | `{ folder_id?, title?, content?, format?, pinned? }` |
| 修改笔记 | `PUT  /api/notes/:id` | `{ title?, content?, format?, folder_id?, pinned? }` |
| 删除笔记 | `DELETE /api/notes/:id` | — |
| 全文搜索 | `GET  /api/search` | `?q=<query>` |
| 版本列表 | `GET  /api/notes/:id/versions` | — |
| 版本详情 | `GET  /api/notes/:id/versions/:vid` | — |
| 恢复到指定版本 | `POST /api/notes/:id/versions/:vid/restore` | — |
| 查看分享链接（无则 `share: null`） | `GET  /api/notes/:id/share` | — |
| 生成分享链接（已有则返回原链接） | `POST /api/notes/:id/share` | — |
| 撤销分享 | `DELETE /api/notes/:id/share` | — |
| 读取分享内容（无需鉴权） | `GET  /api/public/shares/:token` | — |
| 健康检查（无需鉴权） | `GET  /api/health` | — |

`format` 取值：`"txt"`（默认）或 `"md"`。`pinned` 为布尔值；只改 `pinned` 不会更新 `updated_at`。
分享页地址为 `http://<server>:8454/s/<token>`，删除笔记或撤销后链接立即失效。

---

## 给 AI 的提示词（复制粘贴用）

> 你可以通过 HTTP API 直接操作我的在线笔记本，整理我的本地文件并上传。
>
> - 服务器：`http://<your-server>:8454`
> - 鉴权头：`Authorization: Bearer <YOUR_API_TOKEN>`
> - 关键入口：
>   - `POST /api/import` — 批量导入（一次最多 100 篇，folder 路径用 `/` 分隔自动嵌套创建）
>   - `POST /api/notes` — 创建单条
>   - `GET /api/folders` — 看现有文件夹结构
>   - `GET /api/notes?folder_id=all` — 盘点已有笔记
>   - `GET /api/search?q=...` — 查重 / 找相关
>
> 整理一批文件时的标准动作：
>
> 1. 先 `GET /api/folders`，避免重复创建同名文件夹
> 2. 阅读全部文件，按内容主题规划 1–3 级文件夹路径
> 3. 同主题的多篇用一次 `/api/import` 提交
> 4. `format` 默认填 `"txt"`；只有内容里真的用了 Markdown 语法（标题/代码块/列表 等）才填 `"md"`
> 5. `title` 用文件名（去扩展名）或更语义化的标题，content 用原文（必要时清理一下排版）
> 6. 操作前可以 `GET /api/search?q=...` 检查是否已有相似条目，避免重复
>
> 所有 ID 都是整数，时间戳是毫秒。失败时返回 `{ "error": "..." }` + 4xx 状态码。

---

## 开发

```bash
npm install
npm run dev:server   # 后端 :8454，热重载
npm run dev:web      # 前端 :5173，/api 代理到 :8454
npm run build        # 产出 web → public/，被 Fastify 静态托管
```

---

## 架构一览

```
src/                            后端（Node + Fastify）
├── server.js                   入口 + 静态托管 + SPA fallback
├── auth.js                     cookie + Bearer 双鉴权
├── db.js                       SQLite schema + 迁移 + FTS5
└── routes/
    ├── folders.js              文件夹 CRUD
    ├── notes.js                笔记 CRUD + 版本历史
    ├── search.js               FTS5 + LIKE 兜底
    └── import.js               批量导入端点

web/src/                        前端（Vite + TS）
├── main.ts                     入口
├── api.ts                      fetch 封装 + 401 自动回登录
├── auth/login.ts               登录页
└── app/
    ├── index.ts                Shell + 顶栏 + 搜索 + 主题
    ├── state.ts                状态 + 极简 pub/sub
    ├── folder-tree.ts          左栏：嵌套文件夹 CRUD
    ├── note-list.ts            中栏：列表 / 搜索结果切换
    ├── editor.ts               右栏：CodeMirror 6 + markdown-it + 自动保存
    ├── history.ts              版本历史抽屉
    ├── import-ui.ts            全局拖拽 + 文件选择
    └── toast.ts                浮动提示
```

---

## 故障排查

**容器反复重启 + 日志显示 `SQLITE_CANTOPEN`**

老版本镜像里容器用 `node`（UID 1000）跑，bind-mount 进来的 `./data` 是 root 拥有，写不进去。两种解：

```bash
# 解 A：修一次目录权限
sudo chown -R 1000:1000 ./data && docker compose restart notebook

# 解 B：拉最新代码重建（推荐，永久解决）
git pull && docker compose up -d --build
```

**Docker 构建很慢 / better-sqlite3 编译失败**

镜像 build stage 装了 `python3 + build-essential` 编译 better-sqlite3。在 ARM 小机器（树莓派等）上耗时 10+ 分钟，正常。如果失败，先确认机器有 ≥1 GB 内存。

**忘了密码**

`.env` 改 `NOTEBOOK_PASSWORD` → `docker compose restart notebook` 即可，数据不丢。

**想完全重置数据**

```bash
docker compose down
rm -rf data
docker compose up -d
```

---

## 桌面端 (Tauri v2, Windows/Linux)

仓库内的 `src-tauri/` 是把这套笔记本包成离线优先的桌面客户端。整套前端复用，**远端 API 不变，多出一层 Rust 在本地 SQLite 做缓存 + 同步队列**。

### 一次性准备

1. 服务端 `.env` 必须设置 `API_TOKEN`（≥16 字符）。桌面端**只**走 `Authorization: Bearer <token>`，不复用 cookie/密码。
2. 装 Rust 工具链 (`rustup`)；Linux 还需要 `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`。
3. 仓库根 `npm install`（首次会下载 `@tauri-apps/cli`）。

### 开发态

```bash
npm run tauri:dev
```

`tauri.conf.json` 会自动起 `npm run dev:web`（Vite :5173）并把它套进 Tauri 窗口。Rust 端日志走 stderr。

### 首次运行

1. 主窗口右上角点 ⚙ 打开桌面设置。
2. 填「服务器地址」+「API Token」+「默认快记文件夹」（默认 `随笔记录/快速记录`，远端不存在会在第一次同步时自动按 `/api/import` 创建）。
3. 保存后会立即触发一次同步，状态条出现 `● 已同步`。
4. 快记小窗的全局快捷键是 `Ctrl+Alt+N`（Windows/Linux）。

### 同步状态徽标

笔记列表里每条条目右侧可能出现：

| 徽标 | 含义 |
| :--- | :--- |
| 无 | 已同步 |
| 待新建 | 离线时创建，等待联网 POST `/api/notes` |
| 待保存 | 离线/失败后修改，等待 PUT `/api/notes/:id` |
| 待删除 | 离线/失败后删除，等待 DELETE `/api/notes/:id` |
| 失败 | 重试 8 次仍失败，可在设置抽屉里点「重试失败」 |
| 冲突 | 远端 `updated_at > 本地 last_synced_at` 且本地仍 dirty（第一版默认保留本地） |

### 打包

```bash
# Windows (.msi / -setup.exe)
npm run tauri:build

# Linux (.deb / .AppImage)
npm run tauri:build
```

产物落在 `src-tauri/target/release/bundle/`。**图标**默认是 `src-tauri/icons/` 里的占位文件；要发布前先跑 `npx @tauri-apps/cli icon path/to/source.png` 生成正式图标。

### 用 GitHub Actions 发版

推送 `v*` tag 会触发 `.github/workflows/release-desktop.yml`，在 Windows / Linux 上打包并上传到**草稿 Release**：

```bash
# 1. 改 src-tauri/tauri.conf.json 的 "version"（安装包版本以它为准），提交并推送
# 2. 打 tag 并推送
git tag v0.2.0
git push origin v0.2.0
```

在仓库 Actions 页查看进度（约 15–20 分钟），完成后到 Releases 页检查草稿并点「Publish release」。产物：Windows `.msi` + `-setup.exe`，Linux `.deb` + `.AppImage`。安装包未签名，Windows 首次安装会出现 SmartScreen 提示。

### 本地数据位置

| 平台 | 路径 |
| :--- | :--- |
| Windows | `%LocalAppData%\com.notebookpi.desktop\` |
| Linux | `~/.local/share/com.notebookpi.desktop/` |

里面有 `notebookpi.db`（本地缓存）、`device.seed`（机器派生加密种子）、`secrets.bin`（加密后的 API Token）。**不要把这三个文件随仓库提交**——`.gitignore` 已经把 `*.secrets.bin` 加进黑名单。

### 故障排查（桌面端）

**状态条一直显示「未配置」**
没填服务器地址或 API Token。打开设置抽屉补全。

**「失败 N」越来越大**
查 `src-tauri` 控制台日志；常见原因：服务端 `API_TOKEN` 不一致、URL 拼错、CORS（自托管反代时把 Bearer header 透传）。点设置抽屉里的「重试失败」会清零 retry_count 重跑队列。

**快记快捷键不响应**
某些 Linux 桌面环境（如 Wayland + GNOME）需要在系统设置允许全局快捷键；Windows 通常无需额外授权。

---

## License

MIT


