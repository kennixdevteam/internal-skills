# jira-issue-research — 用法

十個實際場景。每個都係「你打一句嘢，skill 自己拆 keyword → 搵 → 讀 → 歸納」，你唔使識 JQL。

規則同內部步驟見 [SKILL.md](SKILL.md)。用嘅係 [jira-connector](../jira-connector/) 個 MCP server，純讀，唔會開 ticket 唔會改嘢。

**共通前提**：keyword 一律譯做英文（Jira ticket 全部英文寫），你照用中文同佢講嘢就得。

---

## 1. 搵歷史處理方法（最主力嘅用法）

> ABC project，搵尋 quote detail 之後返回主頁，主頁啲 indicator 唔更新

拆出 `quote detail`、`indic*`、`refresh` / `stale`、`home` / `dashboard`，優先行 `resolution IS NOT EMPTY` 搵已解決嘅，讀埋 comment（fix 通常寫喺嗰度），最後歸納「呢類問題之前係點處理」，每點指返邊張 ticket。

**注意**：`quote`、`home` 呢類通用字會中好多，佢會叫你補一個 component 或者內部叫法。

---

## 2. 開新 ticket 前查重

> 我想開張 ticket 講 export PDF 中文字變亂碼，ABC 入面有冇人開過？

唔限 `resolution IS NOT EMPTY`（未解決嘅一樣算重複），搵 `export`、`PDF`、`garbl*` / `encoding` / `UTF`。有就俾返 key 同狀態，冇就明講搵唔到、列返試過咩 keyword。

**注意**：佢查完唔會幫你開 ticket。要開就明講「幫我開」，走 jira-connector 嘅寫入流程。

---

## 3. 客戶投訴原文（未技術化）

> 客戶 email 話「份報表數字同上個月對唔上，有時 refresh 完先啱」，ABC / DEF 兩個 project 睇下

由白話抽 `report`、`mismatch` / `inconsistent`、`refresh`、`cache`、`stale`，兩個 project 一次過搵（`project in ("ABC","DEF")`）。

**注意**：多 project 結果會雜，出結果嗰陣佢會標明每張 ticket 屬邊個 project。

---

## 4. 由 error message / stack trace 入手

> ABC，`NullPointerException at QuoteServiceImpl.calculateTotal`，有冇撞過

呢個係最易搵嘅一種 —— class name、method name 係專有名詞，噪音極少。直接 `text ~ "QuoteServiceImpl"`，通常一兩條 query 搞掂。

**注意**：exception 訊息太長就淨係搵最獨特嗰段（class / method 名），成句貼落去反而中唔到。

---

## 5. 判斷係新 bug 定 regression

> ABC，login 之後 session 好快斷。呢個係咪 regression？之前修過未？

搵 `session`、`timeout`、`expire`，重點睇**已 Done 嘅舊 ticket** 有冇同樣 symptom，同埋佢哋幾時 close、修咗咩。

**注意**：搵到舊 ticket 已 Done 但你而家又撞返 → 佢會指出可能係 regression，並俾返舊 ticket 嘅 fix 內容做對照。

---

## 6. 某 module 過去一年出過咩問題

> ABC 嘅 payment module，過去 12 個月有咩已知問題？

`component = "Payment" AND created >= -12M`。呢類 query 通常會 `truncated`，佢會用 `next_cursor` 攞齊個 key list（唔讀全文），再按類型／狀態分組講返個概況。

**注意**：唔知有咩 component 可以切，佢會先叫 `jira_list_fields`。

---

## 7. 接手工作前摸底

> 我要接手 DEF project 嘅 reporting 部分，有咩坑要知？

搵 reporting 相關嘅 ticket，重點揀 **有 workaround、有長 comment thread、重複出現**嗰啲 —— 呢啲先係坑。

**注意**：呢個用法搵到嘅嘢好依賴大家有冇寫 comment。搵唔到唔代表冇坑。

---

## 8. 估算參考

> ABC，要做一個新嘅 bulk import 功能，之前做過類似嘅嘢冇？

搵 `import`、`bulk`、`batch`，睇 `type = Story` / `Task` 嘅舊 ticket：做咗幾多張、story points 幾多、拖咗幾耐、中途撞到咩。

**注意**：story points 個 custom field 每個 instance 唔同，佢會靠 `jira_list_fields` 認返。

---

## 9. 某個客的歷史問題

> ACME Bank 呢個客過去有咩 issue？

用 customer tag 搜（`"Customer Tag" ~ "ACME"`）。呢個 field 每個 Jira 叫法唔同，佢會先 `jira_list_fields` 確認 id。

**注意**：認唔到就會問返你嗰個欄位實際叫咩名，唔會自己估。

---

## 10. 由一句會議記錄／Confluence 內容追返 ticket

> 會議紀錄寫住「Q3 要處理埋 quote 逾期自動失效」，ABC 入面有冇對應 ticket？

搵 `quote`、`expir*` / `auto expire`、`lapse`，唔限狀態（可能仲喺 backlog 未做）。

**注意**：搵到 backlog 未做嘅 ticket 佢會講明「有 ticket 但未開始」，唔會當成已經有方案。

---

## 唔啱用呢個 skill 嘅情況

| 情況 | 應該點 |
|---|---|
| 你已經知 ticket key（`ABC-123`） | 直接叫 `jira_get_issue_tree`，唔使搵 |
| 想攞某個 epic 下面所有 ticket | `jira_get_epic_children` |
| 想開 ticket / 改 ticket / 留 comment | 走 [jira-connector](../jira-connector/SKILL.md) 嘅寫入流程 |
| 要搵嘅嘢喺 Confluence 唔喺 Jira | [confluence-connector](../confluence-connector/SKILL.md) |

## 用之前要知嘅三件事

1. **搵唔到就係搵唔到。** Skill 寫死咗唔准用一般技術常識砌個「處理方法」扮係 Jira 搵返嚟。見到佢話搵唔到，係好事。
2. **搜尋範圍跟你個 Jira account 權限。** 你睇唔到嘅 project 等於唔存在。
3. **結果一定有 ticket key 同 url。** 冇 ticket 支持嘅結論，佢要另外標明係推測 —— 見到冇 key 嘅「處理方法」就要質疑。
