# Review: 笔记新建目录上下文感知 + 搜索结果自动预览高亮

**ID:** P-20260629-001  
**Type:** feature | **Tier:** T2  
**Created:** 2026-06-29T18:13:08  
**Completed:** 2026-06-30T15:43:00  

## Analysis

**Problem:** 两个相关的 UX 问题:
1) 新建笔记的目录归属不符合直觉。当前实现 (web/src/app/note-list.ts:142) 仅基于 state.selectedFolderId 决定 targetFolder:'all' -> null(未归类),否则用选中的文件夹 id。这导致在'全部笔记'视图下点新建,新笔记总是落到'未归类',即使用户正在浏览/编辑的笔记明显属于某个文件夹。同样的逻辑也存在于 web/src/app/import-ui.ts:71 的拖拽导入。
2) 搜索后没有自动预览。当前 (web/src/app/index.ts:78-99) 搜索完成只刷新中间列表,右侧编辑器保持空白或上一篇笔记,用户必须再手动点击一次列表条目才能看到内容。同时即使打开了命中的笔记,编辑器内也不会自动滚动到匹配位置或高亮关键词。

**Scope:** 前端 web/src/app/* 单点改造,后端 API 不动:
- web/src/app/note-list.ts: newNote 目录归属 fallback 链
- web/src/app/import-ui.ts: 拖拽导入复用同一 fallback
- web/src/app/index.ts: 搜索完成后自动 dispatch note:select 第一条命中,并传递 searchQuery
- web/src/app/editor.ts: openNote 完成后,根据 searchQuery 在 CodeMirror 中定位首个匹配 -> scroll + selection + 临时 highlight,markdown preview 同步加 <mark> 包裹
- 不涉及 src-tauri/desktop 端 IPC 协议变化,也不涉及后端 src/routes/* 路由改动。

**Constraints:**
- 保持现有 KISS:不引入新依赖,纯前端 DOM/CodeMirror API 实现
- 不破坏'全部笔记'视图下没有 currentNote 时的现有行为(仍落到未归类)
- 搜索高亮在切换笔记或清空 searchQuery 时必须自动撤销,不能污染普通编辑态
- IME 输入态、自动保存、移动到文件夹等现有交互必须保留
- 首个匹配定位用 case-insensitive 简单 indexOf,不引入正则/FTS 复杂度;后端 FTS5 已经做了模糊匹配,前端只需把 q 当 substring 找一次

## Design Decisions

### D-001: 在 web/src/app/note-list.ts 的 newNote 中引入三段 fallback 链:
  1) selectedFolderId 是具体 number 或 null(明确选中真实文件夹/未归类) -> 直接用
  2) selectedFolderId === 'all' 且 currentNote 存在 -> 用 currentNote.folder_id
  3) selectedFolderId === 'all' 且无 currentNote -> null(兜底维持旧行为)
抽到一个共享的 resolveCreationTarget() 函数,note-list.ts 和 import-ui.ts 复用,DRY。

**Rationale:** undefined

**Tradeoffs:** 选 currentNote.folder_id 作为'全部笔记'下的 fallback,优点是零额外交互、利用既有上下文、向后兼容(没 currentNote 时行为不变);缺点是用户在'全部笔记'下打开了笔记 A(属于文件夹 F)后,新建会进 F——如果用户其实想进未归类,要手动移动一次。权衡后认为这是合理 trade:用户主动选了'全部笔记'+ 打开了 A,意图大概率是续写 F 系列;少数想要未归类的用户可以通过点'未归类'再点新建覆盖。

### D-002: 1) **自动选中第一条命中**:web/src/app/index.ts 的 runSearch 在 results 非空且 state.searchQuery 仍为 q 时(防 race),dispatch CustomEvent('note:select', { id: results[0].id })。仅当当前 currentNote.id 与 results[0].id 不同才触发,避免重复 openNote。
2) **编辑器跳转 + 高亮**:web/src/app/editor.ts 的 openNote 完成后(state.currentNote 已替换),若 state.searchQuery 非空,调用新增的 highlightMatches(query):
   - 在 CodeMirror 中用 EditorView.findRanges 或简单 indexOf (case-insensitive) 找到所有匹配的 [from,to] 区间
   - 用一个 StateField + Decoration.mark 应用 .cm-search-hit class(背景色 yellow/orange,定义在 global.css)
   - 把第一个匹配设为 selection 并 scrollIntoView({y:'center'})
   - markdown preview 渲染后,对 previewEl 做一次 DOM walk,把所有 textNode 里的 q substring 包成 <mark class="preview-hit">(注意只走 textNode,跳过 <pre><code>/<script> 等避免破坏代码高亮)
3) **清除时机**:state.searchQuery 变空 -> editor.ts 监听 searchQuery 变化(新增 channel 'search' 或直接复用 searchClear 事件),清掉 StateField + previewEl 内 <mark.preview-hit> 还原 textNode;切换笔记(currentNote 变化)时由 renderShell 重建 CodeMirror,decoration 自然清空,preview 重新渲染时若 searchQuery 仍在则继续高亮。

**Rationale:** undefined

**Tradeoffs:** 选前端 indexOf + Decoration.mark + preview DOM walk,优点是零新依赖、跟现有架构无缝、txt/md 都覆盖、跳转+高亮一气呵成;缺点是 indexOf 是 substring 匹配,跟后端 FTS5 的 trigram 匹配语义略有差异(FTS 能命中前缀/词形变化,前端 indexOf 不能)。这种 case 表现是:列表说有命中、但编辑器跳不到位置——可接受的退化,fallback 到不滚动+不高亮,功能不崩。

### D-003: 高亮命中数硬上限 200 个匹配(超出后只 mark 前 200,不影响首匹配跳转),query 长度 < 2 时不触发高亮(避免单字符产生上千 mark);跳转用第一个匹配即可,不做'第几个/总几个'的导航器(YAGNI)。

**Rationale:** undefined

**Tradeoffs:** 200 上限是工程上'够用即可',如果以后真有用户抱怨再扩;query<2 阈值挡住误触发。

## Execution

| Item | Status | Evidence |
|------|--------|----------|
| E-001: resolveCreationTarget + note-list.ts newNote 接入 | done | state.ts:resolveCreationTarget() added (fallback chain: explicit folder > currentNote.folder_id in 'all' view > null). note-list.ts:newNote 改为调用 resolveCreationTarget(). |
| E-002: import-ui.ts 复用 resolveCreationTarget | done | import-ui.ts 拖拽/选择导入路径改为 resolveCreationTarget(),与 newNote 共享同一 fallback,DRY 达成。 |
| E-003: editor.ts 新增 search-highlight 模块 + clearSearchHighlights API | done | editor.ts 新增 searchHighlightField (StateField+Decoration), applySearchHighlight()/clearSearchHighlights() exports; on('currentNote') 回调后调用;renderPreview 内若 searchQuery 在则 markPreviewHits;MAX_HITS=200, MIN_QUERY_LEN=2 防御。 |
| E-004: index.ts runSearch auto-select + 监听清空 searchQuery 调清高亮 | done | index.ts runSearch:命中非空时若 currentNote 与第一条不同则 dispatch note:select 自动打开,相同则直接 applySearchHighlight;零命中时 clearSearchHighlights;q 变空时 clearSearchHighlights。 |
| E-005: global.css 加 .cm-search-hit / mark.preview-hit 样式(light/dark) | done | global.css 新增 .cm-search-hit 和 .prose mark.preview-hit 样式,light/dark 两套配色,与 .note-excerpt mark 同色系。 |
| E-006: npm run build 构建验证 | done | npm run build 通过:163 modules transformed, vite v5.4.21 built in 2.99s,无 TS error;chunk size warning 系既有(main 797kB),与本次改动无关。 |

## Verification

**All gating passed:** true

- **C-001:** PASS — vite v5.4.21 build success in 2.99s, 163 modules transformed, no TS errors
- **C-002:** PASS — note-list.ts:142 uses resolveCreationTarget(); state.ts 新增的函数实现 fallback 链:explicit folder->use it; 'all'+currentNote->currentNote.folder_id; 'all'+no currentNote->null。import-ui.ts:71 同样改为 resolveCreationTarget()。
- **C-003:** PASS — index.ts runSearch:results 非空且 currentNote.id !== results[0].id 时 dispatch note:select 自动打开;相同笔记直接 applySearchHighlight;零命中 clearSearchHighlights;空 q 同样 clearSearchHighlights。editor.ts MAX_HITS=200, MIN_QUERY_LEN=2 常量定义,导出 applySearchHighlight/clearSearchHighlights。
- **C-004:** PASS — on('currentNote') 重建 cmView 时 Decoration 自然丢弃(EditorState.create 时 searchHighlightField create()=Decoration.none);renderPreview 末尾根据 state.searchQuery 决定是否 markPreviewHits,clearPreviewMarks 后还跑 root.normalize() 合并 textNode;markDirty/saveNow 等编辑路径与高亮模块完全解耦,无新增订阅。
- **C-005:** PASS — global.css 同时定义 light 默认色(rgba(217,119,6,0.28))和 :root[data-theme='dark'] 覆盖(rgba(224,138,30,0.32)),outline 同步换色,跟既有 --accent 色系保持一致。

## Event Timeline

- 2026-06-29T18:13:08 — **proposal_created** | P-20260629-001 笔记新建目录上下文感知 + 搜索结果自动预览高亮
- 2026-06-29T18:17:09 — **stage_changed** | intake→analysis
- 2026-06-29T18:18:37 — **stage_changed** | analysis→design
- 2026-06-29T18:19:16 — **stage_changed** | design→plan
- 2026-06-29T18:19:38 — **item_added** | [E-001] | resolveCreationTarget + note-list.ts newNote 接入
- 2026-06-29T18:19:38 — **item_added** | [E-002] | import-ui.ts 复用 resolveCreationTarget
- 2026-06-29T18:19:38 — **item_added** | [E-003] | editor.ts 新增 search-highlight 模块 + clearSearchHighlights API
- 2026-06-29T18:19:38 — **item_added** | [E-004] | index.ts runSearch auto-select + 监听清空 searchQuery 调清高亮
- 2026-06-29T18:19:39 — **item_added** | [E-005] | global.css 加 .cm-search-hit / mark.preview-hit 样式(light/dark)
- 2026-06-29T18:19:39 — **item_added** | [E-006] | npm run build 构建验证
- 2026-06-29T18:19:39 — **stage_changed** | plan→execution
- 2026-06-29T18:20:13 — **item_status_changed** | todo→doing | [E-001]
- 2026-06-29T18:20:46 — **item_status_changed** | doing→done | [E-001] | state.ts:resolveCreationTarget() added (fallback chain: explicit folder > currentNote.folder_id in 'all' view > null). note-list.ts:newNote 改为调用 resolveCreationTarget().
- 2026-06-29T18:21:01 — **item_status_changed** | todo→doing | [E-002]
- 2026-06-29T18:21:08 — **item_status_changed** | doing→done | [E-002] | import-ui.ts 拖拽/选择导入路径改为 resolveCreationTarget(),与 newNote 共享同一 fallback,DRY 达成。
- 2026-06-29T18:21:26 — **item_status_changed** | todo→doing | [E-003]
- 2026-06-29T18:23:47 — **item_status_changed** | doing→done | [E-003] | editor.ts 新增 searchHighlightField (StateField+Decoration), applySearchHighlight()/clearSearchHighlights() exports; on('currentNote') 回调后调用;renderPreview 内若 searchQuery 在则 markPreviewHits;MAX_HITS=200, MIN_QUERY_LEN=2 防御。
- 2026-06-29T18:24:19 — **item_status_changed** | todo→doing | [E-004]
- 2026-06-29T18:24:31 — **item_status_changed** | doing→done | [E-004] | index.ts runSearch:命中非空时若 currentNote 与第一条不同则 dispatch note:select 自动打开,相同则直接 applySearchHighlight;零命中时 clearSearchHighlights;q 变空时 clearSearchHighlights。
- 2026-06-29T18:24:49 — **item_status_changed** | todo→doing | [E-005]
- 2026-06-29T18:25:28 — **item_status_changed** | doing→done | [E-005] | global.css 新增 .cm-search-hit 和 .prose mark.preview-hit 样式,light/dark 两套配色,与 .note-excerpt mark 同色系。
- 2026-06-29T18:25:50 — **item_status_changed** | todo→doing | [E-006]
- 2026-06-29T18:26:24 — **item_status_changed** | doing→done | [E-006] | npm run build 通过:163 modules transformed, vite v5.4.21 built in 2.99s,无 TS error;chunk size warning 系既有(main 797kB),与本次改动无关。
- 2026-06-29T18:26:24 — **stage_changed** | execution→verify
- 2026-06-29T18:27:32 — **verify_result_recorded** | [C-001] | passed
- 2026-06-29T18:27:32 — **verify_result_recorded** | [C-002] | passed
- 2026-06-29T18:27:32 — **verify_result_recorded** | [C-003] | passed
- 2026-06-29T18:27:32 — **verify_result_recorded** | [C-004] | passed
- 2026-06-29T18:27:33 — **verify_result_recorded** | [C-005] | passed
- 2026-06-29T18:27:47 — **stage_changed** | verify→pending_acceptance
- 2026-06-30T15:42:02 — **acceptance** | ai_relay→ | confirmed_by_user:true
- 2026-06-30T15:42:02 — **stage_changed** | pending_acceptance→done
- 2026-06-30T15:43:00 — **knowledge_saved** | skipped
