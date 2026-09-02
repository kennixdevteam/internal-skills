# internal-skills

Agent skills for GitHub Copilot in VS Code, on the intranet Mac.

規則見 [CLAUDE.md](CLAUDE.md) — 重點：skill 只可以掂內聯 GitHub / Confluence / Jira / Jenkins，唔可以出外網；每個 skill 一個獨立 folder。

## Setup（user 層級，唔係 repo 層級）

Jira / Confluence connector 係**跟人跟機**嘅 tool —— 跟你部 Mac 同你自己個 account 走，唔屬於任何一個 project。所以兩個 MCP server 都要註冊喺 **VS Code user 嘅 `mcp.json`**：

Command Palette（`⇧⌘P`）→ **MCP: Open User Configuration** →
`~/Library/Application Support/Code/User/mcp.json`

兩個 server 共用同一個 file：`inputs` 係一個 array、`servers` 係一個 object，加 entry 入去，唔好用一個 skill 嘅 `config.example.json` 覆蓋成個 file。Token 一律行 `${input:...}` 由 VS Code 保管，唔好寫入任何 file。

設定一次，之後任何 workspace 開 Copilot Chat agent mode 都用到。

逐個 skill 嘅詳細步驟見 [jira-connector/README.md](jira-connector/README.md) 同 [confluence-connector/README.md](confluence-connector/README.md)。

> 呢個 repo 本身**唔會**有 `.vscode/mcp.json`。只有當某個 project 要駁去唔同嘅 Jira / Confluence instance，先至喺嗰個 project 加 workspace 層級 config（而且入面唔可以有 token，因為個 file 會 commit）。

## Skills

| Folder | 做乜 |
|---|---|
| [jira-connector](jira-connector/) | 讀寫內聯 Jira 嘅 MCP server。讀 ticket 全部內容（連 parent chain、epic 下所有 ticket、sprint、customer tag、link、@mention）；可開新 ticket 同 comment；改 ticket 要先出 diff 俾用戶確認；冇 delete。 |
| [confluence-connector](confluence-connector/) | 讀寫內聯 Confluence 嘅 MCP server。一次過讀一個 list 嘅 page，自動跟住內文嘅 Confluence link 讀落去；可開新 page 同 comment；改 page 要行 preview → confirm → apply 三段式；冇 delete、冇 trash、冇 archive。 |
