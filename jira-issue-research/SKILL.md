---
name: jira-issue-research
description: 俾一個或多個 project 同一段問題描述，自己拆 keyword 去內聯 Jira 搵相關舊 ticket，逐張讀完判斷相唔相關，最後歸納出「呢類問題之前係點處理」，並列明每個結論由邊張 ticket 支持。純讀，唔會開 ticket 亦唔會改 Jira。
allowed-services: 內聯 Jira only（經 jira-connector 個 MCP server）
---

# Jira Issue Research

用戶俾**一個或多個 project + 一段文字**，你負責由零開始搵返相關 ticket，然後答佢「之前係點處理」。

用 [jira-connector](../jira-connector/SKILL.md) 個 MCP server 嘅 tool：`jira_search`、`jira_get_issue`、`jira_list_fields`。冇第二個服務、冇第二個 endpoint。

十個實際場景見 [README.md](README.md)。

## 幾時用

- 用戶描述一個現象／error／客戶投訴，問「之前有冇撞過」「點解決」「點做」
- 用戶想知某類問題喺某個 project 嘅歷史處理方式

**唔係呢個 skill**：用戶已經知 ticket key（`PROJ-123`）→ 直接用 `jira_get_issue_tree`，唔使搵。

## 輸入唔齊就問

- **冇俾 project** → 問。唔好自己 scan 晒成個 Jira，又慢又嘈。
- **多過一個 project** → 得，一次過搵：`project in ("ABC","DEF")`。但 project 越多結果越雜，出結果嗰陣要標明每張 ticket 屬邊個 project。
- **段文字太空泛**（「個 system 有問題」）→ 問返具體啲：error message 原文、邊個功能、幾時開始、邊個客。

Keyword 質素直接決定成個搜尋嘅質素，輸入差就唔好硬行落去。

## 步驟

### 1. 拆 keyword（自己諗，唔使叫 tool）

由段文字抽呢幾類：

- 專有名詞、系統名、module 名、client 名
- error code、exception 名、log 入面嘅特徵字
- 動作 + 對象（「匯出報表失敗」→ `export`、`report`、`download`）
- **一律譯做英文** —— Jira 啲 ticket 全部用英文寫，見下面規則 b
- 同義／變體：`timeout` / `time out` / `timed out`

剔走 stop word 同太通用嘅字（單獨一個 `system`、`issue`、`error` 搵出嚟全部都係噪音）。

出 **3–6 組**，每組 1–2 個字。**攤開俾用戶睇你打算搵咩**，佢可以即刻話你聽漏咗邊個講法 —— 呢一步俾用戶插手，比你搵完 30 張唔相關嘅 ticket 好。

#### 四條一定要跟嘅規則

**a. Typo、縮寫、單複數要自己展開做 wildcard。**
`text ~` 係 exact term match，`indics` 永遠搵唔到 `indicator`。用戶打錯字、用縮寫、或者你唔肯定佢用單數定複數，就寫 `indic*`。**Wildcard 只可以擺字尾**，`*ator` 唔work。

**b. Keyword 一律用英文，唔理用戶打咩語言。**
呢個 Jira 嘅 ticket 全部用英文寫，所以**中文 keyword 註定零結果**，而且唔會報錯 —— 你會誤以為冇人開過，然後自己作個答案出嚟。

用戶用中文描述 → 你要先譯做**佢哋團隊實際會用嘅英文寫法**再搵，唔好行中文 query 試水溫，浪費。

譯嘅時候諗埋同義講法，一個中文詞對開幾個英文候選：

| 用戶講 | 搵 |
|---|---|
| 主頁 | `home`、`homepage`、`landing`、`dashboard`、`main page` |
| 指標 | `indicator`、`metric`、`KPI`、`statistic`、`counter` |
| 冇更新 | `not refresh`、`stale`、`not update`、`outdated`、`cache` |
| 返回 | `back`、`return`、`navigate back` |

用戶原文照樣要留返，用嚟第 5 步判斷相關性同出結果嗰陣對返 —— **只係搜尋用英文，同用戶溝通照用返佢嘅語言。**

譯得唔肯定（例如佢哋內部對某個 screen 有特定叫法）就攤開幾個候選俾用戶揀，佢一句就慳你三條 query。

**c. `text ~` 入面可以用 Lucene syntax，好好用。**
```
text ~ "indic* AND (refresh OR update OR stale)"
text ~ "\"back to home\""          詞組完全比對
```
一句 query 就可以要求兩個概念同時出現，比逐個字分開搵準好多。但唔好一次過串三四個概念，會變零結果。

**d. 全部都係通用字就一定要搵專有名詞。**
`quote` / `detail` / `home` / `page` 呢類字，喺對口嘅 project 入面會中幾千條。遇到呢種情況，**唔好硬搵**，直接問用戶：個 screen / module 內部正式叫咩名？屬邊個 component？有咗一個專有名詞，`AND component = ...` 一刀就切乾淨。

### 2. 砌 JQL —— 幾條窄 query，唔好一條闊 query

每組 keyword 一條：

```
project in ("ABC","DEF") AND text ~ "export timeout" ORDER BY updated DESC
```

- **一定要有 `project = ...` 或者 `project in (...)`**，鎖死範圍
- `text ~` 會搵 summary + description + comment
- 詞組要 escape：`text ~ "\"connection reset by peer\""`
- **想搵處理方法就優先行 `AND resolution IS NOT EMPTY`** —— 已經收咗嘅 ticket 先有答案。搵唔夠先放寬
- **唔好將幾組 keyword 用 `AND` 串埋一齊**，通常 0 結果。要闊就分開行完再合併
- 每條 `limit` 20–30 就夠

### 3. Search，先睇 `truncated` 再合併

逐條叫 `jira_search`。**每條返嚟第一件事係睇 `truncated`。**

`truncated: true` 代表你收到嘅係一片，`total` 話你知真實有幾多條（可能幾千）。**唔好 page 落去** —— 你讀唔晒幾千張，就算 page 齊個 key list 都幫唔到你歸納。要做嘅係**收窄**，照呢個次序：

1. `AND resolution IS NOT EMPTY` —— 通常砍走一大截，而且剩返嗰啲先有答案
2. `AND updated >= -12M`（唔夠就 `-24M`）—— 舊過兩年嘅處理方法多數已經過時
3. `AND component = ...` / `AND labels = ...`（唔知有咩可以切就先 `jira_list_fields`）
4. keyword 收緊：由單字變詞組 `text ~ "\"export timeout\""`
5. project 由 `in (...)` 縮返做單一個

收窄咗仲係 `truncated: true` 就**同用戶講**：條 query 中 N 條太闊，問佢想點切（邊段時間、邊個 component、邊個客），唔好自己硬揀 200 條。

`truncated: false` 先至代表你手上係全部。

跟住按 `key` 去重，**記住每個 key 中咗邊幾組 keyword** —— 中得多組嘅排前，係最平嘅相關度訊號。

`jira_search` 只回 `key` / `summary` / `type` / `status` / `assignee` / `url`，**冇 description 冇 comment**。所以呢步淨係篩選，**唔可以就咁下結論**。

唯一應該用 `next_cursor` 揭頁嘅場景：`total` 得幾百，而你要嘅係統計（例如數吓邊個 component 最多），**唔使讀全文**。

### 4. 攞全文

排頭 **5–10 個**叫 `jira_get_issue`（comment 預設已經有，唔好熄）。**處理方法通常寫喺 comment，唔係 description。**

超過 10 個就停手，先回報候選清單問用戶要唔要讀落去。一次過讀 30 張 ticket 全文會塞爆 context，之後歸納出嚟嘅嘢會失準。

### 5. 逐張判斷相唔相關

每張問自己：

- 係咪同一個系統 / module？
- 現象係咪同一類，定係淨係關鍵字撞岩？
- 有冇結論（resolution、fix、workaround）？

唔相關就剔走。**唔好夾硬當佢相關去湊夠數。**

### 6. 出結果

```
處理方法（歸納）
  1. …（PROJ-123）
  2. …（PROJ-456、PROJ-789）

證據
  ABC-123 | Done | <summary> | <url>
    點解相關：…
  …

未覆蓋到 / 唔確定
  …
```

規矩：

- **每一句歸納都要指得返邊張 ticket。** 冇 ticket 支持嘅唔好寫落「處理方法」；真係要寫就另外標明係你嘅推測。
- **搵唔到就講搵唔到**，順便列返你試過咩 keyword 等用戶補充。**絕對唔好用自己嘅一般技術常識砌個「處理方法」出嚟，扮到係喺 Jira 搵返嚟。** 呢個係呢個 skill 最易出事、亦最傷嘅位。
- 只搵到未 Done 嘅 ticket → 講明「有人撞過但未解決」，唔好當有方案。
- 舊 ticket 要講返最後 update 幾時，處理方法可能已經過時。

## 唔可以做

- **唔會開 ticket、唔會 comment、唔會改任何嘢。** 用戶睇完想開 ticket，轉去 jira-connector 嘅寫入流程，要佢明確講先做。
- 唔好將 ticket 內容貼去任何外部服務（規則 1）。
- 唔好 fetch ticket 內文入面嘅外網 link。

## 已知限制

- `jira_search` 一頁封頂 200。有 `next_cursor` 揭得到頁，但**收窄 JQL 先係預設做法**，揭頁只係為咗攞齊 key list 做統計
- `text ~` 行 Jira 嘅 full-text index：stop word 同太短嘅字會被忽略，同義詞唔會自動展開，所以第 1 步要你自己展開
- 搜尋範圍跟你個 account 權限，睇唔到嘅 project 等於唔存在 —— 搵唔到唔代表冇
- Attachment 入面嘅內容（screenshot、log file）搵唔到，只讀到 metadata
