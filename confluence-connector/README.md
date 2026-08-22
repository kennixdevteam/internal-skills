# confluence-connector — 安裝同設定

內聯 Confluence 嘅 MCP server。**零第三方依賴** —— 淨係用 Node 內建嘅 `fetch` 同 `readline`，唔使 `npm install`，air-gapped 機都行到。

需要 Node 18 以上（已測 v24）。

## 1. 攞 Confluence token

去 Confluence → 個人頭像 → **Personal Access Tokens** → 開一個新 token。權限跟你自己個 account，唔使 admin。

> 個 token 有幾大權限，個 connector 就淨係做到幾多嘢。想再保險，開個唔可以寫嘅 account，或者設 `CONFLUENCE_READONLY=1`。

## 2. 設定 VS Code

抄 `config.example.json` 去 workspace 嘅 `.vscode/mcp.json`（或者你 user 嘅 `mcp.json`），改兩樣：

- `args` 入面條路徑改成呢個 repo 嘅絕對路徑
- `CONFLUENCE_BASE_URL` 改成你哋內聯 Confluence 嘅 host（連 context path，例如 `https://wiki.internal.example/confluence`）

Token 唔好寫入 file —— 個 config 用 VS Code 嘅 `${input:confluence-token}`，第一次會彈窗問你，之後由 VS Code 保管。

改完喺 Copilot Chat 開 agent mode，個 `confluence-connector` server 就會出現喺 tool list。

## 3. 驗證

```bash
node confluence-connector/test/smoke.mjs     # 唔使連真 Confluence，用 mock server 跑 50 個 assertion
```

連真 Confluence 就叫 `confluence_whoami`，會報返 base URL、偵測到嘅 REST prefix、同你個 account。

## 環境變數

| 變數 | 必需 | 說明 |
|---|---|---|
| `CONFLUENCE_BASE_URL` | ✅ | 內聯 Confluence 根 URL。**所有 request 只會去呢個 host。** |
| `CONFLUENCE_TOKEN` | ✅ | Personal access token |
| `CONFLUENCE_EMAIL` | | 一設低就轉用 Basic auth（Cloud 式）。DC / Server 唔使設，留空用 Bearer。 |
| `CONFLUENCE_READONLY` | | `1` = 熄晒所有寫入 tool |
| `CONFLUENCE_TIMEOUT_MS` | | 每個 request 嘅 timeout，預設 30000 |

REST prefix 唔使設 —— 開機時自動 probe `/rest/api`（Server / DC），唔通就試 `/wiki/rest/api`（Cloud）。

## Tool 一覽

**讀**

| Tool | 做乜 |
|---|---|
| `confluence_read` | 主力。收一個 list（page id / URL / `SPACE:Title` 撈埋都得），一次過讀晒，仲會自動跟住內文嘅 Confluence link 讀落去 |
| `confluence_get_page` | 淨係讀一頁 |
| `confluence_get_page_tree` | 一頁連晒下面所有子頁 |
| `confluence_search` | CQL 搵嘢 |
| `confluence_list_spaces` / `confluence_whoami` | Space 清單 / 連線檢查 |

**寫**（全部要用戶明確講明先做）

| Tool | 做乜 |
|---|---|
| `confluence_create_page` | 開新 page |
| `confluence_add_comment` | 留 comment |
| `confluence_preview_update` | 第 1 段：零寫入，出 diff + `change_token` |
| `confluence_confirm_update` | 第 2 段：用戶批准咗個 diff，出 `apply_token` |
| `confluence_apply_update` | 第 3 段：真正寫入，要 `apply_token` + 第二次確認 |

### `confluence_read` 嘅預設

| 參數 | 預設 | 上限 |
|---|---|---|
| `max_depth` | 1 | 3（`0` = 完全唔追 link） |
| `max_pages` | 25 | 100 |
| `follow_links` | `true` | |
| `include_comments` | `true` | |

外網 link **一律唔會 fetch**，只會列喺 `external_links_not_fetched`。讀唔到嘅頁會列喺 `skipped` 連原因。

## 檔案

```
confluence-connector/
├── SKILL.md                  # 俾 agent 睇：幾時用邊個 tool、寫入政策
├── README.md                 # 呢份
├── config.example.json       # VS Code mcp.json 範本
├── mcp/
│   ├── server.mjs            # entrypoint
│   ├── rpc.mjs               # MCP stdio JSON-RPC
│   ├── confluence-client.mjs # HTTP 層 —— host allowlist、method allowlist、反 trash/archive
│   ├── storage.mjs           # storage format ⇄ text、link / mention / macro 抽取
│   ├── page.mjs              # page 正規化、line diff
│   └── tools.mjs             # tool 定義同 handler
└── test/smoke.mjs            # mock Confluence + 真 MCP server 嘅 end-to-end test
```

## 安全設計（repo 規則 1）

全部喺 code 層強制，唔係靠 prompt 叫模型自律：

| 保證 | 喺邊度實現 |
|---|---|
| 只掂到內聯 Confluence 一個 host | `confluence-client.mjs` 每個 request 比對 `url.host`，唔啱即 throw |
| Redirect 帶唔走你 | `redirect: "manual"`，收到 3xx 直接當錯誤 |
| **冇可能 delete / trash / archive** | 冇相關 tool；`DELETE` 喺 method allowlist 外面；`status: trashed/archived/historical/deleted` 嘅 payload 深層掃描後 reject；`/trash`、`/restriction`、attachment download 路徑一律 reject |
| 改嘢一定經用戶兩次確認 | `preview` → `confirm`（`user_approved`）→ `apply`（`confirm` + `apply_token`）。跳步、換 token、replay 全部 reject；token 15 分鐘過期 |
| 唔會靜靜雞清空一頁 | 新內容淨返原文 20% 都唔夠、或者空白 → 要 `acknowledge_content_loss: true` |
| 改標題唔會整爛 markup | 只傳 `title` 唔傳 `body` 時，原本 storage 原封不動送返上去 |
| 唔會覆蓋人哋改咗嘅嘢 | `apply` 前重新讀 version，對唔上就 reject |
| 唔會外洩 attachment | 只讀 metadata，冇 download / upload 路徑 |
| 外網 link 唔會被 fetch | `confluence_read` 見到非 allowed host 就記低唔追 |
| 零外網依賴 | 冇 `package.json`、冇 npm install、冇 telemetry |

`test/smoke.mjs` 逐條 assert 上面呢啲保證。

## 已知限制（刻意咁做）

- **Storage format 只寫安全 subset**：段落、標題、list、table、fenced code、link、粗體斜體。改 body 會整走原本啲複雜 macro（Jira macro、include、excerpt…）同 @mention。Preview 會出 warning，遇到就叫用戶自己去 UI 改。
- **Label 加得刪唔到**：刪 label 要 HTTP DELETE，已封死。
- **Move / 改 parent / 改權限：冇 tool。** 呢啲影響結構同權限，唔喺 connector 範圍。
- **Attachment 上傳下載：冇。**

### 改呢個 server 之前

1. **唔好加 delete / trash / archive tool，唔好放寬 `ALLOWED_METHODS` 或者 `FORBIDDEN_STATUS`。** 呢條係 repo 規則。
2. 新增嘅寫入 tool 一律行 preview + confirm 兩重確認。
3. 保持零依賴 —— 唔好引入 npm package。
4. 改完跑 `node confluence-connector/test/smoke.mjs`。
