/* 对 ZCode 主窗口渲染层执行 Page.reload（CDP） */
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const target = list.find(t => t.type === "page" && t.title === "ZCode" && (t.url || "").startsWith("file:///Applications/ZCode.app"));
if (!target) { console.log("未找到 ZCode 主窗口 target"); process.exit(1); }
console.log("target:", target.title, target.url.slice(0, 60));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id;
    ws.addEventListener("message", function h(ev) {
      const m = JSON.parse(ev.data);
      if (m.id === mid) { ws.removeEventListener("message", h); resolve(m); }
    });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}
ws.addEventListener("open", async () => {
  await send("Page.enable");
  const r = await send("Page.reload", { ignoreCache: false });
  console.log("Page.reload 结果:", JSON.stringify(r).slice(0, 120));
  setTimeout(() => { ws.close(); process.exit(0); }, 1500);
});
ws.addEventListener("error", (e) => { console.log("WS error:", e.message || e.type); process.exit(1); });
