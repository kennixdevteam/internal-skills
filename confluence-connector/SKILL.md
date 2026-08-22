---
name: confluence-connector
description: 讀寫內聯 Confluence。一次過讀一個 list 嘅 page，自動跟住內文嘅 Confluence link 讀落去（預設深度 1、上限 25 頁）；用戶明確叫先可以開新 page 或者留 comment；改現有 page 一定要行 preview → confirm → apply 三段式，中間俾用戶睇實個 diff。永遠唔會 delete、trash 或者 archive。
allowed-services: 內聯 Confluence only
---

# Confluence Connector

用內聯 Confluence 嘅 MCP server（`mcp/server.mjs`）。所有 request 只去 `CONFLUENCE_BASE_URL` 嗰個 host，其他 host 一律 reject。安裝步驟見 [README.md](README.md)。

## 幾時用

- 用戶貼 Confluence link、講到某頁 wiki、某個 space、某份文件
- 要睇某頁內容、佢下面啲子頁、或者佢連住嘅相關頁
- 要開新 page、留 comment、改現有 page

## 讀 —— 用邊個 tool

| 情況 | Tool |
|---|---|
| **預設：讀嘢** | `confluence_read` |
| 淨係要嗰一頁，唔要相關頁 | `confluence_get_page` |
| 要成個 section / handbook 連晒子頁 | `confluence_get_page_tree` |
| 唔知條 link，要搵 | `confluence_search`（CQL） |
| 想知有咩 space | `confluence_list_spaces` |
| 連唔連到 / 用邊個 account | `confluence_whoami` |

**預設用 `confluence_read`。** 佢做嘅嘢：

- `targets` 收一個 **list**，三種寫法可以撈埋一齊用：page id（`1001`）、page URL、`SPACE:Title`。用戶一次過貼幾條 link，就一次過擺入去，唔好逐條叫。
- 每頁讀晒：body（storage format render 成文字）、labels、version、作者、ancestors 麵包屑、comments、**@mention（自動查返個名）**、attachment metadata
- **自動跟住內文嘅 Confluence link 讀落去**，預設深度 1、上限 25 頁。用戶想深啲就 `max_depth`（最多 3）、`max_pages`（最多 100）。
- **指去外網嘅 link 一定唔會 fetch**，只會列喺 `external_links_not_fetched` 度俾用戶自己撳。

睇返個 `skipped` 同 `truncated` —— 有頁讀唔到（冇權限、超 budget、URL 認唔到）佢會照講，唔好當冇嘢發生。回覆用戶時帶返 `url`。

## 寫 —— 政策

寫入淨係得三樣：**開新 page、留 comment、改現有 page**。三樣都要用戶**明確講明要做**先可以做。

### 開新 page / 留 comment

`confluence_create_page`、`confluence_add_comment`。

- 用戶明確叫你開 / 叫你 comment 先做。「幫我睇下呢頁講乜」**唔係**叫你開嘢。
- `space` 同 `title` 冇齊就問返用戶，**唔好自己估個 space key**。用 `confluence_list_spaces` 俾佢揀。
- Body 寫 markdown 式文字（`#` 標題、`-` list、`|` table、``` code fence、`[文字](link)`），server 會轉做 storage format。

### 「幫我整理」——先問清楚擺邊

用戶叫你「整理」啲內容，有兩個做法，**要跟佢點講**：

- 叫你 **create** / 「開一頁新嘅」/「整份 summary 出嚟」→ `confluence_create_page`，原文零風險
- 叫你 **改返原本嗰頁** → 行落面三段式

佢冇講明擺邊？**問。** 唔好自己揀「改原文」。

### 改現有 page —— 一定要三段式

**絕對唔可以自己主動改 Confluence。** 就算你讀嗰陣見到個標題打錯字、段落亂、資料過時，都唔好自己去改；最多喺回覆入面同用戶講「呢度好似有問題，使唔使我改？」

改嘢固定行呢個流程：

1. `confluence_preview_update` —— **唔會寫任何嘢**，計出 before/after diff，俾返 `change_token`
2. **將個 diff 同所有 `warnings` 原原本本 show 俾用戶睇**，等佢明確講「改得」→ `confluence_confirm_update`（`user_approved: true`），攞返 `apply_token`
3. **再問多次**（講清楚係邊一頁、改乜），用戶再確認 → `confluence_apply_update`（`apply_token` + `confirm: true`）

規矩：

- **兩次確認都要係真係問過用戶。** 唔好連續三個 tool call 一氣呵成 —— step 2 同 step 3 之間一定要有用戶講嘢。
- 跳步冇用：`apply` 收唔到 `change_token`，冇 `apply_token` 直接 reject。
- 用戶想改第二樣 → 重新 `confluence_preview_update`，**唔好自己砌 token**。
- Token 用完即棄，15 分鐘過期。過期就重新 preview + 重新問過。
- Preview 之後有人改過嗰頁 → `apply` 會 reject（version 對唔上），要重新 preview 俾用戶睇新 diff。

### Preview 出 warning 點做

- **`CONTENT LOSS`**（新內容淨返原本 20% 都唔夠、或者空白）→ `requires_extra_acknowledgement: true`。**要特登再同用戶講一次會刪走幾多嘢**，佢照樣話要，先加 `acknowledge_content_loss: true`。
- **`macros this connector does not round-trip`** → 嗰頁有 Jira macro、include、excerpt 之類，改 body 會整走佢哋。**建議用戶自己去 Confluence UI 改**，唔好硬改。
- **mention / attachment 警告** → 改 body 會令 @mention 同 image embed 變返純文字。細節重要嘅頁面，同上，叫用戶自己改。

改標題唔會踩到呢啲 —— 只改 `title` 唔傳 `body`，server 會原封不動保留原本 markup。

### Delete

**冇 delete tool、冇 trash tool、冇 archive tool，亦都永遠唔會加。** 用戶要刪 Confluence page 就同佢講：呢個 connector 唔支援，要佢自己去 Confluence UI 做。唔好諗辦法繞過（例如將 body 清空當刪咗、或者改個 title 做「（已作廢）」）。

Label 同樣：**加得、刪唔到**（刪 label 要行 HTTP DELETE，喺 transport 層已經封死）。要刪就叫用戶自己去 UI。

## 安全（repo 規則 1）

- Server 淨係掂到 `CONFLUENCE_BASE_URL` 嗰個內聯 host，寫死喺 `mcp/confluence-client.mjs`
- Redirect 唔會 follow（防止 302 帶去出面）
- `DELETE` 喺 HTTP 層封死；**`status: trashed / archived` 嘅 payload 一樣封死**（Confluence 唔使 DELETE 都刪到嘢）
- `/trash`、`/restriction`、attachment download 路徑全部 reject
- Attachment 只讀 metadata，唔會 download 或者 upload
- 唔好將 Confluence 內容貼去任何外部服務

## 環境

`CONFLUENCE_BASE_URL`、`CONFLUENCE_TOKEN` 必需；`CONFLUENCE_EMAIL`（Cloud 式 auth 先要）、`CONFLUENCE_READONLY=1`（熄晒寫入）。Server / DC 定 Cloud 唔使設，開機自動偵測。
