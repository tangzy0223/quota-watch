# quota-watch

**5h/weekly window quota guardian + seamless multi-account switching** for the ZCode desktop client (macOS). Single file, zero dependencies (Node built-ins only), runs as a background launchd agent — when the current account's window quota approaches the threshold it switches to another account **without restarting ZCode and without interrupting running tasks**.

> ⚠️ Unofficial third-party tool, not affiliated with Z.ai / Zhipu. Multi-account rotation is discouraged by the vendor — evaluate account risk yourself. All credentials stay on your machine. (中文文档: [README.md](README.md))

## Features

- **Window-based monitoring**: reads the official 5-hour / weekly usage percentage every 30s (same source as the ZCode statusbar quota chip)
- **Threshold auto-switch**: when the active account crosses the threshold (default 80%), switches to the account with the emptiest window
- **Seamless hot swap**: atomically replaces the credentials file — traffic follows the new account within seconds, **no ZCode restart**; a CDP renderer reload syncs the UI account label
- **Safe by default**: backs up the current login before every switch; account profiles stay local; macOS notification after each switch

## How it works (why it's seamless)

Three empirically verified facts:

1. **The ZCode client re-reads `~/.zcode/v2/credentials.json` on every API request** — atomically replacing that file makes new requests authenticate as the new account within seconds. The account name shown in the UI is a startup-time snapshot (cosmetic; refreshable, see below).
2. **The client main process keeps a CDP debug port open (9229)** (injected by the [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) plugin) — after a switch, a `Page.reload` on the renderer refreshes the UI account label. Renderer reloads do not interrupt agent tasks running in the main process.
3. **The credentials envelope key is bound to the file path** (keychain service `ZCode Credential Encryption`, account = sha256(file path)), not to the account — so any account's snapshot restored to the same path decrypts fine.

## Requirements

| Dependency | Requirement |
|---|---|
| macOS | any recent version (launchd / keychain / osascript) |
| Node.js | ≥ 18 (≥ 22 for the post-switch UI label sync) |
| ZCode desktop client | tested on 3.18.x (`enc:v2` envelope credentials + keychain) |
| Accounts | **≥ 2 BigModel (CN) coding-plan accounts** (z.ai international not supported) |
| statusbar plugin (optional) | [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) — only affects post-switch UI label sync |

No npm dependencies, no Python, no admin rights.

## Install

```bash
git clone https://github.com/<you>/quota-watch.git
cd quota-watch
./install.sh
```

Then save your accounts (at least 2):

```bash
# Log into account A in ZCode:
node ~/.zcode/quota-watch/quota-watch.js save main
# Switch ZCode login to account B:
node ~/.zcode/quota-watch/quota-watch.js save backup
# Switch back to your preferred account:
node ~/.zcode/quota-watch/quota-watch.js switch main
```

Done. The launchd agent checks every 30 seconds. First `save`/`probe` triggers one keychain access prompt — click Allow.

## Usage & configuration

See [README.md](README.md) (Chinese) for the full command, configuration and compatibility tables. Quick reference:

```
probe    current account 5h/weekly windows
list     all accounts + live window usage
switch   atomic switch (auto-backup first)
watch    one check cycle (launchd calls this every 30s)
```

`config.json` keys: `threshold_pct` (80), `confirmations` (2), `cooldown_s` (600), `restart_zcode` (false), `cdp_reload` (true).

## Compatibility & known fragilities

The tool relies on four **undocumented** client behaviors; a client update may break any layer. Run `probe` to locate a breakage (probe failing = data layer; probe OK but switching ineffective = behavior layer): per-request credential re-read, CDP 9229 renderer reload, monitor endpoint `data.limits[]` shape, `enc:v2` keychain envelope format. See [README.md](README.md) for the full table with failure modes and fallbacks.

## Disclaimer

Not affiliated with Z.ai / Zhipu. Use at your own risk. Never share `accounts/`, `backups/`, or exported snapshots — they contain full credentials to your accounts.

## Credits

- [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) — enables the CDP port; its quota module's credential knowledge underpins this tool
- [git-l-1031/zcode-switcher](https://github.com/git-l-1031/zcode-switcher), [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch) — inspiration for multi-account switching
