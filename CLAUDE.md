# CLAUDE.md

## 這個 Repo 是什麼

`internal-skills` 用來整理及存放不同的 **agent skills**，最終部署到 **Mac 上 Visual Studio Code 的 GitHub Copilot** 使用。

該部 Mac 係**內聯網（intranet）環境**，所有 skill 的設計、內容同執行方式都必須跟足下面嘅規則。

## 規則 1：網絡限制（最重要）

除咗以下**內聯網服務**之外，skill **不能夠上傳、傳送或外洩任何資料去外網**：

- 內聯 GitHub
- 內聯 Confluence
- 內聯 Jira
- 內聯 Jenkins

實際要求：

- Skill 內**唔可以**有任何指向公網的 endpoint（public API、SaaS、webhook、telemetry、analytics、CDN、外部 LLM service）。
- 任何 `curl` / `wget` / HTTP client / MCP server 的目標，必須係上面四個內聯服務之一。
- 唔可以將 code、log、credential、內部文件內容貼去外部服務做處理。
- 唔好喺 runtime 由公共 registry（npm / PyPI / Homebrew / raw.githubusercontent 等）攞嘢；需要的依賴要行內聯 mirror 或者預先安裝。
- URL 一律用**內聯 hostname**，唔好寫死公網 domain（例如 `github.com`、`atlassian.net`）。
- 有懷疑就當係唔准，先問返用戶確認。

## 規則 2：每個 skill 一個獨立 folder

- 每新增一個 skill，喺 repo root 開一個**獨立 folder**，唔可以將兩個 skill 擺埋同一個 folder。
- Folder 名用 kebab-case，名要講到個 skill 做乜（例如 `jira-ticket-triage`、`jenkins-build-check`）。
- Skill 的檔案（instructions、prompt、script、範例、參考資料）全部放喺自己嗰個 folder 入面，唔好散落其他地方。
- 每個 folder 至少要有一個主檔案（例如 `SKILL.md`）講清楚：skill 做乜、幾時用、點用、依賴咗邊個內聯服務。

## 規則 3：唔清楚就先問

每次收到新指令，如果對指令有疑問、或者對要做嘅嘢唔清楚，**先問返用戶確認，得到答覆先做下一步**。

- 指令有多過一種理解方式 → 問，唔好自己估。
- 唔肯定要改邊個檔案 / 邊個 skill → 問。
- 唔肯定某個 endpoint 或依賴算唔算違反規則 1 → 問。
- 唔好因為想快啲就自行假設，做錯咗要重做更慢。

## 目錄結構

```
internal-skills/
├── CLAUDE.md
├── README.md
├── <skill-name-1>/
│   └── SKILL.md
└── <skill-name-2>/
    └── SKILL.md
```

## 新增 skill 的 checklist

0. 有任何唔清楚 → 先問用戶（規則 3）。
1. 開一個新的獨立 folder，用 kebab-case 命名。
2. 寫主檔案（`SKILL.md`），講清楚用途、觸發時機、步驟。
3. 檢查所有 endpoint / 依賴：只可以掂內聯 GitHub、Confluence、Jira、Jenkins。
4. 確認冇任何嘢會上傳去外網。
5. 確認個 skill 喺 VS Code Copilot（Mac）行得到。
