# quota-watch

ZCode 桌面客户端（macOS）的 **5h/周窗口额度守护 + 多账号无感切换** 工具。单文件、零依赖（仅 Node 内置模块），后台常驻，额度逼近阈值时自动切换账号，**全程不重启客户端、不打断正在执行的任务**。

> ⚠️ 非官方第三方工具，与 Z.ai / 智谱无任何关联。多账号轮换属于官方不鼓励的用法，请自行评估账号风险。所有凭据只保存在本机。

## 功能

- **窗口口径监控**：每 30 秒读取 5 小时 / 周窗口的官方用量百分比（与 ZCode 状态条额度格同源）
- **阈值自动切换**：当前账号窗口用量越过阈值（默认 80%）且连续确认后，自动切到窗口最空的账号
- **无感热切换**：原子替换凭据文件，流量秒级跟随新账号，**无需重启 ZCode**；切换后经 CDP 重载渲染层，UI 账号名同步刷新
- **安全兜底**：切换前自动备份登录态；账号档案全本机存储；切换后 macOS 系统通知告知

## 原理（为什么能"无感"）

三个实测发现撑起了整个设计：

1. **ZCode 客户端每次发请求都会重读 `~/.zcode/v2/credentials.json`** —— 因此原子替换该文件，新请求立即使用新账号的凭据（实测 30 秒内流量跟随），客户端 UI 上显示的账号名则是启动时载入的旧快照（纯装饰，可通过重载渲染层刷新，见下条）
2. **客户端主进程开着 CDP 调试端口 9229**（由 [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) 插件注入）—— 切换后向渲染层发一个 `Page.reload`，UI 账号名即同步刷新；渲染层重载不打断主进程侧正在执行的 agent 任务
3. **凭据信封的解密密钥绑定在凭据文件路径上**（keychain 服务 `ZCode Credential Encryption`，account = sha256(文件路径)），与账号无关 —— 因此任意账号的快照放回同一路径都能被客户端正常解密

```
launchd 每 30s → 查当前账号 5h 窗口
  → ≥ 阈值 且连续 2 次确认、过了冷却期
    → 挑 5h 最空的账号 → 备份 → 原子替换 credentials.json
      → CDP 重载渲染层（UI 名字同步）
      → macOS 系统通知「已切到 XX」
```

## 环境要求

| 依赖 | 要求 |
|---|---|
| macOS | 任意较新版本（launchd / keychain / osascript） |
| Node.js | ≥ 18（≥ 22 才支持切换后的 UI 名字同步） |
| ZCode 桌面客户端 | 实测 3.18.x；凭据格式为 `enc:v2` 信封 + keychain |
| 账号 | **BigModel 国内编码套餐 ≥ 2 个**（z.ai 国际版暂不支持） |
| statusbar 插件（可选） | [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar)——仅影响"切换后 UI 账号名自动同步"，不装也能正常切换 |

无 npm 依赖、无 Python、无需管理员权限。

## 安装

```bash
git clone https://github.com/<you>/quota-watch.git
cd quota-watch
./install.sh
```

安装脚本会：探测 node 绝对路径（nvm/fnm 用户友好）→ 复制脚本到 `~/.zcode/quota-watch/` → 生成默认配置 → 注册 launchd 守护（每 30 秒检查，幂等可重复执行）。

然后**保存你的账号**（至少 2 个）：

```bash
# 在 ZCode 里登录账号 A：
node ~/.zcode/quota-watch/quota-watch.js save 主号
# 在 ZCode 里切换登录账号 B：
node ~/.zcode/quota-watch/quota-watch.js save 备号
# 切回常用账号：
node ~/.zcode/quota-watch/quota-watch.js switch 主号
```

完成。此后守护进程自动工作；首次 `save`/`probe` 会弹一次钥匙串授权，点「允许」。

## 使用

```
node ~/.zcode/quota-watch/quota-watch.js probe           # 当前账号 5h/周窗口
node ~/.zcode/quota-watch/quota-watch.js list            # 所有账号 + 各自窗口用量
node ~/.zcode/quota-watch/quota-watch.js switch 备号      # 手动切换
node ~/.zcode/quota-watch/quota-watch.js doctor          # 七层自检（排障第一步）
node ~/.zcode/quota-watch/quota-watch.js watch           # 手动跑一次检查
tail ~/.zcode/quota-watch/watch.log                      # 守护日志
```

## 数据安全

- 账号档案（`accounts/`）、切换备份（`backups/`）、日志与状态文件权限均为 **0600/0700**，仅当前用户可读
- 档案与备份内含**可直接登录你账号的完整凭据**：不要分享、不要提交进 git（`.gitignore` 已内置）、不要放到网盘/同步盘目录
- **不要同时运行多个切换类工具**（本工具与 zcode-switcher / Z·SWITCH 等操作同一个凭据文件，并发会互相覆盖）

## 路线图

- [ ] Linux 支持（systemd timer 替代 launchd）
- [ ] z.ai 国际版账号支持（api.z.ai 域名 + Bearer 鉴权）
- [ ] 账号档案加密导出/导入（PBKDF2 + AES-256-GCM，跨机器迁移）
- [ ] 周窗口独立阈值（当前仅 5h 触发，周窗口仅展示）

## 配置

`~/.zcode/quota-watch/config.json`（缺失时用默认值，见 [config.example.json](config.example.json)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `threshold_pct` | 80 | 5h 窗口用量百分比达到此值触发切换 |
| `confirmations` | 2 | 连续多少次采样超阈值才执行（防抖） |
| `cooldown_s` | 600 | 切换后冷却秒数（防来回横跳） |
| `restart_zcode` | false | 切换后重启 ZCode（无感模式不需要；留作兜底开关） |
| `cdp_reload` | true | 切换后经 CDP 重载渲染层同步 UI 账号名（statusbar 插件未注入时自动跳过） |

配置保存后**下一个检查周期（≤ 30 秒）自动生效，无需重启任何东西**——守护每轮都现读配置。已累计的防抖确认计数在新阈值判定下会自动复位，不会带着旧计数误触发。

## 兼容性与已知脆弱点

本工具依赖四个**未文档化**的客户端行为，官方更新可能使某一层失效。`probe` 命令可以逐层自检（探针失败 = 数据层断；探针成功但切换无效 = 行为层断）：

| 耦合点 | 依赖的隐性事实 | 失效表现 | 兜底 |
|---|---|---|---|
| 无感切换 | 客户端每次请求重读凭据文件 | 切换后请求仍走旧账号 | 开 `restart_zcode` |
| UI 名字同步 | statusbar 插件注入 CDP 9229 端口；渲染层重载重取身份 | UI 名字滞后（流量不受影响） | 重启一次 ZCode；或关 `cdp_reload` |
| 窗口数据 | monitor 接口返回 `data.limits[]`（unit=3 → 5h，unit=6 → 周） | `probe` 报响应异常 | 等适配 / 提 issue |
| 凭据格式 | `enc:v2` 信封 + keychain 服务名 + account=sha256(路径) | `probe` 报解密/keyId 错误 | 客户端大版本升级后重新适配 |

另：客户端会在切换后立即原地刷新全部 token（同秒写回凭据文件），因此工具用解密后的稳定 user_id 而非文件指纹识别当前账号。

## 常见问题

**切换后 UI 上的账号名没变？** 它只是启动时载入的旧标签，流量实际已走新账号（看状态条额度格 / `list` 即可确认）。装了 statusbar 插件时切换会自动经 CDP 刷新它；实在在意就重启一次 ZCode。

**为什么用 5h 窗口而不是套餐池余额做触发？** 套餐池余额（billing/balance 接口）在窗口限流的套餐上不随 5h 消耗下降，用它做触发会失灵；窗口百分比才是"5 小时/周限额"的直接口径。

**没到阈值但请求开始报额度错误？** 检查 `watch.log` 里守护是否在正常打点；确认 `list` 里至少有两个账号且另一个的 5h 低于阈值。

## 免责声明

本工具与 Z.ai / 智谱无任何关联。多账号轮换属于官方不鼓励的用法，使用本工具产生的账号风险由使用者自行承担。请勿将 `accounts/`、`backups/`、导出的快照分享给任何人——它们包含可直接登录你账号的完整凭据。

## 致谢

- [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) —— CDP 调试端口的开启者；其 quota 模块的凭据解密知识是本工具的基石
- [git-l-1031/zcode-switcher](https://github.com/git-l-1031/zcode-switcher) 与 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch) —— 多账号切换思路的启发
