#!/usr/bin/env node
/* quota-watch — ZCode 5h/周窗口额度守护：监控 + 多账号无感切换（macOS）
 *
 * 客户端每次发请求都会重读 ~/.zcode/v2/credentials.json，因此原子替换该文件即可
 * 在不重启 ZCode 的情况下让流量无缝切到另一个账号（实测 30s 内生效，UI 账号名
 * 经 CDP 渲染层重载同步）。
 *
 * 子命令:
 *   probe                查看当前账号的 5h/周窗口用量
 *   save <名字>          把当前登录态快照保存为账号档案
 *   list                 列出所有档案 + 各自 5h/周用量（逐个查接口）
 *   switch <名字>        原子切换到指定档案（自动备份当前登录态）
 *   watch                单次检查循环（launchd 每 30s 调一次）
 *   watch --loop         前台常驻轮询（调试用）
 *
 * 设计:
 *   - 凭据解密: keychain "ZCode Credential Encryption" (account=sha256(credentials.json 路径))
 *   - 窗口数据: bigmodel.cn /api/monitor/usage/quota/limit → data.limits[] unit=3(5h) unit=6(周)
 *   - 业务 token: oauth:linked_bigmodel（v2 信封→JSON.accessToken）优先，
 *                 旧版平铺键 oauth:bigmodel:access_token 回退
 *   - 切换:     临时文件 + fsync + rename 原子替换 credentials.json，切换前自动备份
 *   - 快照:     ~/.zcode/quota-watch/accounts/<名字>.json（完整 credentials.json + 元数据）
 *   - UI 同步:  切换后经 CDP(9229) 重载渲染层，UI 账号名随之刷新（需 statusbar 插件注入）
 *
 * 配置 ~/.zcode/quota-watch/config.json:
 *   threshold_pct  5h 用量百分比达到此值触发切换（默认 80）
 *   confirmations  连续多少次采样超阈值才执行（默认 2，防抖）
 *   cooldown_s     切换后冷却秒数（默认 600）
 *   restart_zcode  切换后是否重启 ZCode（默认 false，无感模式不需要）
 *   cdp_reload     切换后经 CDP(9229) 重载渲染层同步 UI 账号名（默认 true）
 */
"use strict";
const crypto = require("crypto");
const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, ".zcode", "v2", "credentials.json");
const DIR = path.join(HOME, ".zcode", "quota-watch");
const ACCOUNTS_DIR = path.join(DIR, "accounts");
const BACKUPS_DIR = path.join(DIR, "backups");
const CONFIG_PATH = path.join(DIR, "config.json");
const STATE_PATH = path.join(DIR, "state.json");
const LOG_PATH = path.join(DIR, "watch.log");
const SERVICE = "ZCode Credential Encryption";
const QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 10000;
const VERSION = "1.0.0";

for (const d of [DIR, ACCOUNTS_DIR, BACKUPS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
  try { fs.chmodSync(d, 0o700); } catch (e) { /* 已存在时不强改 */ }
}
for (const f of [LOG_PATH, STATE_PATH, CONFIG_PATH]) {
  try { fs.chmodSync(f, 0o600); } catch (e) { /* 不存在则等首次写入 */ }
}

function log(msg) {
  const line = new Date().toISOString() + "  " + msg;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch (e) {}
  console.log(line);
}
function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; } }
function saveJson(p, obj) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.fsyncSync(fs.openSync(tmp, "r+"));
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (e) {}
}
function loadConfig() {
  return Object.assign({ threshold_pct: 80, confirmations: 2, cooldown_s: 600, restart_zcode: false, cdp_reload: true },
    loadJson(CONFIG_PATH, {}));
}

/* ---------- 凭据解密 ---------- */
let _keyCache = null;
function v2Key() {
  if (_keyCache) return _keyCache;
  const account = crypto.createHash("sha256").update(CREDS_PATH).digest("hex");
  const secret = execFileSync("security",
    ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
    { encoding: "utf8" }).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("keychain 密钥形状异常");
  const key = Buffer.from(secret, "base64url");
  _keyCache = { key, keyId: crypto.createHash("sha256").update(key).digest("hex").slice(0, 24) };
  return _keyCache;
}
function openSeal(enc) {
  if (typeof enc !== "string" || !enc.startsWith("enc:v2:")) return null;
  const [src, kid, seal] = enc.slice("enc:v2:".length).split(":");
  const { key, keyId } = v2Key();
  if (kid !== keyId) throw new Error("信封 keyId 与 keychain 密钥不匹配（宿主换钥？）");
  const [ivb, tagb, ctb] = seal.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64url"));
  d.setAuthTag(Buffer.from(tagb, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctb, "base64url")), d.final()]).toString("utf8");
}
function bigmodelToken(credsObj) {
  // 1) 新式登录态：oauth:linked_bigmodel（v2 信封 → JSON.accessToken）
  const linked = credsObj["oauth:linked_bigmodel"];
  if (typeof linked === "string" && linked.startsWith("enc:v2:")) {
    try {
      const plain = openSeal(linked);
      if (plain) {
        const obj = JSON.parse(plain);
        if (obj && typeof obj.accessToken === "string") return obj.accessToken;
      }
    } catch (e) { /* 解不开落到旧键回退 */ }
  }
  // 2) 旧式：oauth:bigmodel:access_token 平铺键（v2 信封或明文 JWT，statusbar 同款兼容口径）
  const legacy = credsObj["oauth:bigmodel:access_token"];
  if (typeof legacy === "string" && legacy) {
    if (legacy.startsWith("enc:v2:")) {
      try { const t = openSeal(legacy); if (t) return t; } catch (e) {}
    } else if (legacy.startsWith("eyJ")) return legacy;
  }
  return null;
}

/* ---------- 额度探针 ---------- */
async function probeWindows(token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(QUOTA_URL, { headers: { authorization: token }, signal: ctl.signal });
    const body = await res.json();
    if (!(body && body.success && body.data && Array.isArray(body.data.limits))) {
      throw new Error("响应异常 code=" + (body && body.code));
    }
    const out = { h5: null, week: null, resets: {} };
    for (const l of body.data.limits) {
      if (l.type !== "TOKENS_LIMIT") continue;
      if (l.unit === 3) { out.h5 = l.percentage; out.resets.h5 = l.nextResetTime; }
      if (l.unit === 6) { out.week = l.percentage; out.resets.week = l.nextResetTime; }
    }
    return out;
  } finally { clearTimeout(t); }
}

/* ---------- 档案 ---------- */
function activeCreds() { return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")); }
function credsFingerprint(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}
/* 稳定账号标识：token 会刷新（信封指纹几小时就失效），user_id 不会。
 * 优先 zai_cn user_info.user_id，兜底 linked_bigmodel.userId。 */
function accountIdOf(credsObj) {
  for (const [key, field, prefix] of [
    ["oauth:zai_cn:user_info", "user_id", ""],
    ["oauth:linked_bigmodel", "userId", "bm:"],
  ]) {
    try {
      const raw = credsObj[key];
      const plain = typeof raw === "string" ? openSeal(raw) : null;
      if (!plain) continue;
      const o = JSON.parse(plain);
      if (o && o[field]) return prefix + String(o[field]);
    } catch (e) { /* 解不开换下一个 */ }
  }
  return null;
}
function listAccounts() {
  return fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith(".json")).map(f => {
    const meta = loadJson(path.join(ACCOUNTS_DIR, f), {});
    return { id: f.slice(0, -5), file: path.join(ACCOUNTS_DIR, f), meta };
  });
}
function activeAccountId() {
  const cur = accountIdOf(activeCreds());
  if (!cur) return null;
  for (const a of listAccounts()) {
    const snap = loadJson(a.file, null);
    if (snap && accountIdOf(snap.credentials) === cur) return a.id;
  }
  return null;
}

/* ---------- 通知 ---------- */
function notify(msg) {
  try {
    execFile("osascript", ["-e", `display notification "${String(msg).replace(/"/g, "'")}" with title "quota-watch"`],
      { timeout: 5000 }, () => {});
  } catch (e) {}
}

/* ---------- 子命令 ---------- */
async function cmdProbe() {
  const token = bigmodelToken(activeCreds());
  if (!token) throw new Error("当前 credentials.json 解不出 bigmodel 业务 token");
  const w = await probeWindows(token);
  const active = activeAccountId();
  console.log(JSON.stringify({ active_account: active, ...w, h5_reset: w.resets.h5 ? new Date(w.resets.h5).toISOString() : null, week_reset: w.resets.week ? new Date(w.resets.week).toISOString() : null }, null, 1));
}

async function cmdSave(name) {
  if (!name || /[\/\\]/.test(name)) throw new Error("用法: quota-watch.js save <名字>（名字不能含路径符）");
  const creds = activeCreds();
  if (!bigmodelToken(creds)) throw new Error("当前登录态解不出业务 token，拒绝保存空壳档案");
  const file = path.join(ACCOUNTS_DIR, name + ".json");
  saveJson(file, {
    name, savedAt: new Date().toISOString(),
    active_provider: creds["oauth:active_provider"] || "",
    credentials: creds,
  });
  log(`已保存账号档案「${name}」→ ${file}`);
  console.log(`已保存「${name}」(${Object.keys(creds).length} 个凭据条目)`);
}

async function cmdList() {
  const active = activeAccountId();
  const accounts = listAccounts();
  if (!accounts.length) { console.log("档案库为空。先 quota-watch.js save <名字>"); return; }
  console.log(`共 ${accounts.length} 个档案:`);
  for (const a of accounts) {
    const snap = loadJson(a.file, null);
    let win = "?";
    try {
      const token = snap && bigmodelToken(snap.credentials);
      if (!token) win = "(token 解不开)";
      else {
        const w = await probeWindows(token);
        win = `5h ${w.h5 == null ? "?" : w.h5 + "%"} / 周 ${w.week == null ? "?" : w.week + "%"}`;
      }
    } catch (e) { win = "(查询失败 " + e.message.slice(0, 40) + ")"; }
    console.log(`  ${a.id === active ? "★" : " "} ${a.id.padEnd(12)} ${win}  保存于 ${a.meta.savedAt || "?"}`);
  }
  if (!active) console.log("  ⚠ 当前登录态不在档案库中（save 一份？）");
}

async function cmdSwitch(name) {
  const target = path.join(ACCOUNTS_DIR, name + ".json");
  const snap = loadJson(target, null);
  if (!snap) throw new Error(`档案「${name}」不存在`);
  const snapCreds = snap.credentials;
  if (!bigmodelToken(snapCreds)) throw new Error("目标档案解不出业务 token，拒绝切换");

  const current = activeCreds();
  if (accountIdOf(current) && accountIdOf(current) === accountIdOf(snapCreds)) {
    console.log(`已经在「${name}」上了，无需切换`);
    return;
  }
  // 切换前备份当前登录态（0600，内含完整登录凭据）
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = path.join(BACKUPS_DIR, `credentials.switch.${ts}.json`);
  fs.copyFileSync(CREDS_PATH, bak);
  fs.chmodSync(bak, 0o600);
  // 原子替换（保留原文件权限）
  const st = fs.statSync(CREDS_PATH);
  const tmp = CREDS_PATH + ".quota-watch.tmp";
  fs.writeFileSync(tmp, JSON.stringify(snapCreds, null, 2) + "\n", { mode: st.mode });
  fs.fsyncSync(fs.openSync(tmp, "r+"));
  fs.renameSync(tmp, CREDS_PATH);

  const state = loadJson(STATE_PATH, {});
  state.activeId = name; state.lastSwitchAt = Date.now(); state.lastSwitchFromBackup = bak;
  saveJson(STATE_PATH, state);
  const w = await probeWindows(bigmodelToken(snapCreds));
  log(`已切换到「${name}」（5h ${w.h5}% / 周 ${w.week}%）。原登录态备份: ${bak}`);
  notify(`已切换到「${name}」，5h ${w.h5}% / 周 ${w.week}%`);
  console.log(`✅ 已切换到「${name}」，5h ${w.h5}% / 周 ${w.week}%`);

  // UI 同步：CDP 重载渲染层（实测身份标签与流量都会跟随凭据文件；inject-main 开着 9229 端口）
  const cfg = loadConfig();
  if (cfg.cdp_reload !== false) {
    try {
      execFileSync(process.execPath, [path.join(DIR, "cdp-reload.mjs")], { timeout: 8000, stdio: "pipe" });
      log("已触发渲染层重载（UI 账号名同步）");
    } catch (e) { log("CDP 重载跳过（overlay 未注入或端口不可达）: " + String(e.message).slice(0, 60)); }
  }
  if (cfg.restart_zcode) {
    /* 优雅退出 → 轮询等进程消失（最长 10s，用 ps+comm 精确匹配，pgrep -x/-f 在 macOS 上都不可靠）→ 重新拉起 */
    execFile("/bin/bash", ["-c",
      `osascript -e 'tell application "ZCode" to quit' >/dev/null 2>&1; ` +
      `for i in $(seq 1 20); do ps -eo comm | grep -qx "ZCode" || break; sleep 0.5; done; ` +
      `open -a ZCode`], { timeout: 30000 }, () => {});
    log("已请求重启 ZCode（让新登录身份生效）");
  } else {
    console.log("如客户端未生效，重跑一次加 config restart_zcode=true，或手动重启 ZCode");
  }
}

async function probeWithCache(id, file) {
  const snap = loadJson(file, null);
  const token = snap && bigmodelToken(snap.credentials);
  if (!token) return null;
  try { return await probeWindows(token); } catch (e) { return null; }
}

function cmdVersion() { console.log("quota-watch v" + VERSION); }

async function cmdDoctor() {
  let fail = 0;
  const ok = (m) => console.log("  ✅ " + m);
  const bad = (m) => { fail++; console.log("  ❌ " + m); };
  console.log("quota-watch 自检 v" + VERSION);
  // 1) 平台与 node
  if (process.platform === "darwin") ok("macOS"); else bad("非 macOS，本工具仅支持 macOS");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok("Node " + process.versions.node);
  else if (major >= 18) console.log("  ⚠ Node " + process.versions.node + "：核心可用，UI 名字同步（需≥22）将跳过");
  else bad("Node " + process.versions.node + " 过低（需≥18）");
  // 2) 凭据文件与解密链
  if (!fs.existsSync(CREDS_PATH)) { bad("credentials.json 不存在: " + CREDS_PATH); return finish(); }
  ok("credentials.json 存在");
  let token = null;
  try { token = bigmodelToken(activeCreds()); } catch (e) { bad("keychain/解密: " + e.message.slice(0, 60)); return finish(); }
  if (token) ok("业务 token 解密成功（" + token.slice(0, 6) + "…）"); else bad("解不出 bigmodel 业务 token（登录态缺 linked_bigmodel/legacy 键）");
  // 3) monitor 接口
  try {
    const w = await probeWindows(token);
    ok(`monitor 端点: 5h ${w.h5 == null ? "?" : w.h5 + "%"} / 周 ${w.week == null ? "?" : w.week + "%"}`);
  } catch (e) { bad("monitor 探针失败: " + e.message.slice(0, 60)); }
  // 4) CDP（UI 同步）
  if (loadConfig().cdp_reload === false) console.log("  ⚠ cdp_reload=false，UI 名字同步已关闭");
  else {
    try {
      const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
      list.some(t => t.type === "page" && t.title === "ZCode") ? ok("CDP 9229 + ZCode 渲染层可达（UI 名字同步可用）")
        : bad("CDP 9229 可达但未见 ZCode 渲染层（statusbar 插件未注入？）");
    } catch (e) { console.log("  ⚠ CDP 9229 不可达（statusbar 插件未装/未生效）：切换正常，仅 UI 名字不自动同步"); }
  }
  // 5) 档案库
  const accounts = listAccounts();
  ok(`档案库 ${accounts.length} 个账号` + (accounts.length < 2 ? "（自动切换需 ≥2）" : ""));
  const active = activeAccountId();
  if (active) ok("当前登录态已入库: " + active); else bad("当前登录态未入库（save 一份），守护不会监控");
  // 6) launchd
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/com.quota-watch.daemon`], { stdio: "pipe" });
    ok("launchd 守护已加载");
  } catch (e) { console.log("  ⚠ launchd 守护未加载（手动模式或未运行 install.sh）"); }
  // 7) 数据权限
  const perms = [];
  for (const d of [ACCOUNTS_DIR, BACKUPS_DIR]) perms.push((fs.statSync(d).mode & 0o777).toString(8));
  perms.every(p => p === "700") ? ok("数据目录权限 700") : bad("数据目录权限非 700: " + perms.join("/"));
  finish();
  function finish() {
    console.log(fail ? `\n${fail} 项未通过` : "\n全部通过");
    process.exitCode = fail ? 1 : 0;
  }
}

async function cmdWatch(loopMode) {
  const cfg = loadConfig();
  const state = loadJson(STATE_PATH, { consecutiveOver: 0 });
  const active = activeAccountId();
  if (!active) { log("当前登录态未入库，无法监控（quota-watch.js save <名字>）"); return; }

  const token = bigmodelToken(activeCreds());
  if (!token) { log("当前登录态解不出 token"); return; }
  let w;
  try { w = await probeWindows(token); }
  catch (e) { log("探针失败: " + e.message.slice(0, 60)); return; }

  log(`「${active}」5h ${w.h5}% / 周 ${w.week}%`);
  if (w.h5 == null || w.h5 < cfg.threshold_pct) {
    if (state.consecutiveOver) saveJson(STATE_PATH, Object.assign(state, { consecutiveOver: 0 }));
    return;
  }
  const over = (state.consecutiveOver || 0) + 1;
  if (over < cfg.confirmations) {
    saveJson(STATE_PATH, Object.assign(state, { consecutiveOver: over }));
    log(`5h ${w.h5}% ≥ ${cfg.threshold_pct}%（第 ${over}/${cfg.confirmations} 次确认）`);
    return;
  }
  if (state.lastSwitchAt && Date.now() - state.lastSwitchAt < cfg.cooldown_s * 1000) {
    log(`5h ${w.h5}% 超阈值，但冷却期内（${Math.ceil((state.lastSwitchAt + cfg.cooldown_s * 1000 - Date.now()) / 1000)}s），跳过`);
    return;
  }
  // 找一个 5h 更空的档案
  const candidates = [];
  for (const a of listAccounts()) {
    if (a.id === active) continue;
    const w2 = await probeWithCache(a.id, a.file);
    if (w2 && w2.h5 != null) candidates.push({ id: a.id, h5: w2.h5, week: w2.week });
  }
  if (!candidates.length) { log("5h 超阈值，但档案库里没有其他可用账号"); notify("5h 额度耗尽，且没有其他账号可切"); return; }
  candidates.sort((a, b) => a.h5 - b.h5);
  const best = candidates[0];
  if (best.h5 >= cfg.threshold_pct) { log(`所有账号 5h 都 ≥ ${cfg.threshold_pct}%（最低 ${best.id} ${best.h5}%），不切`); notify("所有账号 5h 额度都接近耗尽"); return; }
  log(`触发切换：「${active}」5h ${w.h5}% → 「${best.id}」5h ${best.h5}%`);
  await cmdSwitch(best.id);
}

/* ---------- 入口 ---------- */
const cmd = process.argv[2];
const arg = process.argv[3];
(async () => {
  try {
    if (cmd === "probe") await cmdProbe();
    else if (cmd === "save") await cmdSave(arg);
    else if (cmd === "list") await cmdList();
    else if (cmd === "switch") await cmdSwitch(arg);
    else if (cmd === "doctor") await cmdDoctor();
    else if (cmd === "version") cmdVersion();
    else if (cmd === "watch") {
      const loopMode = arg === "--loop";
      if (loopMode) {
        for (;;) { await cmdWatch(true).catch(e => log("watch error: " + e.message)); await new Promise(r => setTimeout(r, 30000)); }
      } else await cmdWatch();
    }
    else console.log("用法: quota-watch.js <probe|save <名>|list|switch <名>|doctor|version|watch [--loop]>");
  } catch (e) {
    const msg = e.message || String(e);
    log("ERROR (" + (cmd || "-") + "): " + msg);
    console.error("ERROR: " + msg);
    process.exit(1);
  }
})();
