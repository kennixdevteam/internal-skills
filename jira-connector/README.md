# jira-connector — 安裝同設定

內聯 Jira 嘅 MCP server。**零第三方依賴** —— 淨係用 Node 內建嘅 `fetch` 同 `readline`，唔使 `npm install`，air-gapped 機都行到。

需要 Node 18 以上（已測 v24）。

## 1. 攞 Jira token

去 Jira → 個人頭像 → **Profile / Personal Access Tokens** → 開一個新 token。權限跟你自己個 account，唔使 admin。

## 2. 設定 VS Code（user 層級）

Jira connector 係**你個人嘅 tool**，跟你部機同你個 Jira account 走，唔跟住某一個 repo，所以要裝喺 **user 層級嘅 `mcp.json`**，唔好放喺 project 嘅 `.vscode/mcp.json`。

開個 file：Command Palette（`⇧⌘P`）→ **MCP: Open User Configuration**。macOS 實際路徑係：

```
~/Library/Application Support/Code/User/mcp.json
```

抄 `config.example.json` 入面 `inputs` 同 `servers` 兩忽落去，改兩樣：

- `args` 入面條路徑改成呢個 repo 喺你機上面嘅絕對路徑
- `JIRA_BASE_URL` 改成你哋內聯 Jira 嘅 host

如果個 file 已經有其他 server（例如 `confluence-connector`），**唔好覆蓋成個 file** —— 將 `inputs` 嘅 entry 加入去原本個 array，將 `jira-connector` 加入去原本個 `servers` object：

```jsonc
{
  "inputs": [
    { "id": "confluence-token", "type": "promptString", "description": "Confluence personal access token", "password": true },
    { "id": "jira-token", "type": "promptString", "description": "Jira personal access token", "password": true }
  ],
  "servers": {
    "confluence-connector": { /* ... */ },
    "jira-connector": { /* ... */ }
  }
}
```

Token 唔好寫入 file —— 個 config 用 VS Code 嘅 `${input:jira-token}`，第一次會彈窗問你，之後由 VS Code 保管。

設定完之後，**任何 workspace** 開 Copilot Chat agent mode 都見到 `jira-connector` 喺 tool list，唔使逐個 repo 再設一次。

> 想淨係喺某一個 project 出現（例如個 repo 用另一個 Jira instance），先至抄去嗰個 workspace 嘅 `.vscode/mcp.json`。留意嗰個 file 會 commit 入 repo，所以入面唔可以有 token。

## 3. 驗證

```bash
node jira-connector/test/smoke.mjs        # 唔使連真 Jira，用 mock server 跑 28 個 assertion
```

連真 Jira 就叫 `jira_whoami`，會報返 base URL、偵測到嘅 API 版本、同你個 account。

## 環境變數

| 變數 | 必需 | 說明 |
|---|---|---|
| `JIRA_BASE_URL` | ✅ | 內聯 Jira 根 URL，例如 `https://jira.internal.example`。**所有 request 只會去呢個 host。** |
| `JIRA_TOKEN` | ✅ | Personal access token |
| `JIRA_EMAIL` | | 一設低就轉用 Basic auth（Cloud 式）。DC / Server 唔使設，留空用 Bearer。 |
| `JIRA_READONLY` | | `1` = 熄晒所有寫入 tool |
| `JIRA_TIMEOUT_MS` | | 每個 request 嘅 timeout，預設 30000 |
| `JIRA_SPRINT_FIELD` | | 覆寫 sprint 嘅 custom field id |
| `JIRA_CUSTOMER_TAG_FIELD` | | 覆寫 customer tag，可以逗號分隔多過一個 |
| `JIRA_EPIC_LINK_FIELD` | | 覆寫 Epic Link 嘅 custom field id |

API 版本（v2 定 v3）唔使設 —— 開機時自動 probe `/rest/api/3/myself`，唔通就 fallback `/rest/api/2/myself`。ADF 同 wiki markup 兩種 description 格式都處理到。

### Custom field 對唔啱？

Sprint / customer tag 嘅 custom field id 每個 Jira instance 都唔同，server 靠 `/rest/api/{v}/field` 自動認：

- Sprint、Epic Link、Epic Name 認 Atlassian 嘅 schema key，好穩陣
- **Customer tag 靠名認**（`/customer|client|tenant/i`），認錯嘅話用 `jira_list_fields` 搵返正確 id，再用 `JIRA_CUSTOMER_TAG_FIELD` 覆寫

就算認唔到都唔會漏 —— 所有有值嘅 custom field 都會用返個顯示名放喺 `custom_fields` 度。

## 檔案

```
jira-connector/
├── SKILL.md              # 俾 agent 睇：幾時用邊個 tool、寫入政策
├── README.md             # 呢份
├── config.example.json   # VS Code mcp.json 範本
├── mcp/
│   ├── server.mjs        # entrypoint
│   ├── rpc.mjs           # MCP stdio JSON-RPC
│   ├── jira-client.mjs   # HTTP 層 —— host allowlist、method allowlist
│   ├── adf.mjs           # ADF ⇄ text、@mention 抽取
│   ├── fields.mjs        # custom field 偵測、sprint 解析
│   ├── issue.mjs         # issue 正規化
│   └── tools.mjs         # tool 定義同 handler
└── test/smoke.mjs        # mock Jira + 真 MCP server 嘅 end-to-end test
```

## 安全設計（repo 規則 1）

全部喺 code 層強制，唔係靠 prompt 叫模型自律：

| 保證 | 喺邊度實現 |
|---|---|
| 只掂到內聯 Jira 一個 host | `jira-client.mjs` 每個 request 比對 `url.host`，唔啱即 throw |
| Redirect 帶唔走你 | `redirect: "manual"`，收到 3xx 直接當錯誤 |
| **冇可能 delete Jira** | 冇 delete tool；`DELETE` 喺 method allowlist 外面，transport 層就擋 |
| 改嘢一定經用戶 | `jira_apply_update` 冇 `jira_preview_update` 出嘅 token 就 reject；token 用完即棄、15 分鐘過期 |
| 唔會外洩 attachment | 只讀 metadata，冇 download / upload 路徑 |
| 零外網依賴 | 冇 `package.json`、冇 npm install、冇 telemetry |

`test/smoke.mjs` 逐條 assert 上面呢啲保證。

### 改呢個 server 之前

1. **唔好加 delete tool，唔好放寬 `ALLOWED_METHODS`。** 呢條係 repo 規則。
2. 新增嘅寫入 tool 一律行 preview + confirm 兩段式。
3. 保持零依賴 —— 唔好引入 npm package。
4. 改完跑 `node jira-connector/test/smoke.mjs`。
