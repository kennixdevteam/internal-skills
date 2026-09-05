---
name: jira-connector
description: 讀寫內聯 Jira。讀 ticket 全部內容（description、link、parent、sprint、customer tag、@mention 等），自動連 parent chain 同 epic 下面所有 ticket 一齊讀；可以開新 ticket、寫 comment；改現有 ticket 一定要先出 diff 俾用戶確認。永遠唔會 delete。
allowed-services: 內聯 Jira only
---

# Jira Connector

用內聯 Jira 嘅 MCP server（`mcp/server.mjs`）。所有 request 只去 `JIRA_BASE_URL` 嗰個 host，其他 host 一律 reject。安裝步驟見 [README.md](README.md)。

## 幾時用

- 用戶提到 ticket key（`PROJ-123`）、Jira link、epic、sprint、backlog
- 要睇 ticket 內容、關聯、狀態、負責人
- 要開新 ticket、留 comment、改 ticket

## 讀 —— 用邊個 tool

| 情況 | Tool |
|---|---|
| **預設：讀一張 ticket** | `jira_get_issue_tree` |
| 淨係要嗰張 ticket 本身，唔要上下文 | `jira_get_issue` |
| 想攞 epic 下面所有 ticket | `jira_get_epic_children` |
| 用條件搵一堆 ticket | `jira_search`（JQL，**一定要睇 `truncated`**） |
| 唔知某個欄位嘅 custom field id | `jira_list_fields` |
| 想知而家可以轉去邊個 status | `jira_get_transitions` |
| 連唔連到 / 用邊個 account | `jira_whoami` |

### `jira_search` 嘅 `truncated`

一頁封頂 200。條 query 闊嘅話你收到嘅係**一片**，唔係全部。所以每次 search 之後：

- **`truncated: false`** → 呢個就係全部，安心用
- **`truncated: true`** → `total` 話你知真實有幾多條。**預設反應係收窄條 JQL，唔係 page 落去。** 唔收窄就下結論，等於攞住 3000 條入面嘅 200 條當成全貌
- 真係要攞齊個 key list（做統計、數 component）先至用 `next_cursor` 當 `cursor` 傳返入去揭下一頁

**預設用 `jira_get_issue_tree`，唔好用 `jira_get_issue`。** 佢一次過做晒：

- 讀曬張 ticket 所有內容 —— description、status、assignee/reporter、priority、labels、components、fix version、**sprint**、**customer tag**、story points、**issue links**（blocks / relates to / duplicates，連方向）、comments、**@mention**、attachment metadata，同埋所有有值嘅 custom field
- **有 parent 就連 parent 一齊讀**，一路行上去到最頂（`ancestors`）
- **如果係 epic，就列曬 epic 入面所有 ticket**（`children`）

回覆用戶時，帶返 `url` 方便佢撳。

## 寫 —— 政策

寫入淨係得三樣：**開新 ticket、寫 comment、改現有 ticket**。三樣都要用戶**明確講明要做**先可以做。

### 開新 ticket / 寫 comment

`jira_create_issue`、`jira_add_comment`。

- 用戶明確叫你開 / 叫你 comment 先做。「幫我睇下呢張 ticket」**唔係**叫你開嘢。
- 唔好自己作欄位。project、issue type、summary 冇齊就問返用戶，唔好估。

### 改現有 ticket —— 一定要兩段式

**絕對唔可以自己主動改 Jira。** 就算你覺得個 summary 打錯字、個 label 唔啱，都唔好自己去改。

改嘢固定行呢個流程：

1. `jira_preview_update` —— **唔會寫任何嘢**，只係計出 before/after diff，同埋俾返一個 `change_token`
2. **將個 diff 原原本本 show 俾用戶睇**，等佢明確講「改得」
3. `jira_apply_update`，帶住 step 1 嗰個 `change_token` 同 `confirm: true`

規矩：

- **未 preview 過、未問過用戶，就唔可以叫 `jira_apply_update`。** 冇 token 佢會 reject。
- 用戶想改第二樣 → 重新叫 `jira_preview_update`，**唔好自己改個 token**。
- Token 用完即棄，15 分鐘過期。過期就重新 preview + 重新問過。
- 轉 status 都算「改」，一樣行呢個流程（`transition_to`）。

### Delete

**冇 delete tool，亦都永遠唔會加。** 用戶要 delete Jira 就同佢講：呢個 connector 唔支援，要佢自己去 Jira UI 做。唔好諗辦法繞過（例如用 comment 講「已刪除」、或者將 ticket 清空當刪咗）。

## 安全（repo 規則 1）

- Server 淨係掂到 `JIRA_BASE_URL` 嗰個內聯 host，寫死喺 `mcp/jira-client.mjs`
- Redirect 唔會 follow（防止 302 帶去出面）
- `DELETE` 喺 HTTP 層封死
- Attachment 只讀 metadata，唔會 download 或者 upload
- 唔好將 Jira 內容貼去任何外部服務

## 環境

`JIRA_BASE_URL`、`JIRA_TOKEN` 必需；`JIRA_EMAIL`（Cloud 式 auth 先要）、`JIRA_READONLY=1`（熄晒寫入）、`JIRA_SPRINT_FIELD` / `JIRA_CUSTOMER_TAG_FIELD`（自動偵測唔啱時覆寫）。
