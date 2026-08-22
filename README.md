# internal-skills

Agent skills for GitHub Copilot in VS Code, on the intranet Mac.

規則見 [CLAUDE.md](CLAUDE.md) — 重點：skill 只可以掂內聯 GitHub / Confluence / Jira / Jenkins，唔可以出外網；每個 skill 一個獨立 folder。

## Skills

| Folder | 做乜 |
|---|---|
| [jira-connector](jira-connector/) | 讀寫內聯 Jira 嘅 MCP server。讀 ticket 全部內容（連 parent chain、epic 下所有 ticket、sprint、customer tag、link、@mention）；可開新 ticket 同 comment；改 ticket 要先出 diff 俾用戶確認；冇 delete。 |
| [confluence-connector](confluence-connector/) | 讀寫內聯 Confluence 嘅 MCP server。一次過讀一個 list 嘅 page，自動跟住內文嘅 Confluence link 讀落去；可開新 page 同 comment；改 page 要行 preview → confirm → apply 三段式；冇 delete、冇 trash、冇 archive。 |
