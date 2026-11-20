import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CFG = window.ST_CONFIG;
const sb = createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const FN = `${CFG.url}/functions/v1/stash`;
const BUCKET = "stash";
const $ = id => document.getElementById(id);

let user = null;
let items = [];
let shown = null;        // 検索結果（null のときは全件）
let tiles = [];
let kindFilter = "all";
let tagFilter = null;
let askMode = false;
let current = null;      // 詳細表示中のアイテム
let addFiles = { imgs: [], pdf: null };

const KIND = { web: "Web", sns: "SNS", image: "写真", pdf: "PDF", note: "メモ" };
const GLYPH = { web: "WEB", sns: "SNS", image: "IMG", pdf: "PDF", note: "MEMO" };

/* ---------- util ---------- */
function toast(msg, ms = 2400) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), ms); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }
function fmtDate(s) { if (!s) return ""; const d = new Date(s); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`; }
function fmtWhen(s) {
  if (!s) return "";
  const m = (Date.now() - new Date(s).getTime()) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}分前`;
  if (m < 60 * 24) return `${Math.round(m / 60)}時間前`;
  return `${Math.round(m / 1440)}日前`;
}
function openSheet(id) { $(id).classList.remove("hidden"); $(id).querySelector(".pane").scrollTop = 0; }
function closeSheet(id) { $(id).classList.add("hidden"); }
document.querySelectorAll(".sheet").forEach(s => {
  s.addEventListener("click", e => { if (e.target === s || e.target.closest("[data-close]")) s.classList.add("hidden"); });
});

async function call(action, body = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CFG.key, Authorization: `Bearer ${session?.access_token ?? ""}` },
    body: JSON.stringify({ action, ...body }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `エラー (${r.status})`);
  return d;
}

// 写真を長辺 max px のJPEGに縮小
async function shrink(file, max = 1600, quality = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/jpeg", quality));
}
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
}

/* ---------- 署名付きURL（端末に1日覚えておく） ---------- */
const URL_KEY = "stash-urls", URL_TTL = 60 * 60 * 24;
const urls = {};
function urlCache() { try { return JSON.parse(localStorage.getItem(URL_KEY) || "{}"); } catch { return {}; } }
async function ensureUrls(paths) {
  const now = Date.now(), cache = urlCache(), need = [];
  for (const p of new Set(paths.filter(Boolean))) {
    if (urls[p]) continue;
    const c = cache[p];
    if (c && c.e > now + 3600e3) urls[p] = c.u; else need.push(p);
  }
  if (need.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, URL_TTL);
    (data || []).forEach(u => { if (u.signedUrl) { urls[u.path] = u.signedUrl; cache[u.path] = { u: u.signedUrl, e: now + URL_TTL * 1000 }; } });
    for (const k of Object.keys(cache)) if (cache[k].e < now) delete cache[k];
    try { localStorage.setItem(URL_KEY, JSON.stringify(cache)); } catch {}
  }
}
const thumbOf = it => it.thumb_path || it.image_path;

/* ---------- 一覧 ---------- */
const COLS = "id,kind,url,title,site,author,summary,tags,memo,og_image,image_path,thumb_path,file_path,status,error,pinned,created_at";
async function loadItems() {
  const { data, error } = await sb.from("stash_items").select(COLS).order("created_at", { ascending: false }).limit(500);
  if (error) { toast("読み込めませんでした：" + error.message); return; }
  items = data || [];
  await ensureUrls(items.map(thumbOf));
  renderChips(); renderList();
}
function renderChips() {
  const kinds = ["all", ...Object.keys(KIND).filter(k => items.some(i => i.kind === k))];
  $("kindChips").innerHTML = kinds.map(k => `<button class="chip ${kindFilter === k ? "on" : ""}" data-k="${k}">${k === "all" ? `すべて ${items.length}` : KIND[k]}</button>`).join("");
  const count = new Map();
  items.forEach(i => (i.tags || []).forEach(t => count.set(t, (count.get(t) || 0) + 1)));
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  $("tagChips").innerHTML = top.map(([t, n]) => `<button class="chip ${tagFilter === t ? "on" : ""}" data-t="${esc(t)}">#${esc(t)} <span class="mu">${n}</span></button>`).join("");
  $("tagChips").classList.toggle("hidden", !top.length);
}
$("kindChips").onclick = e => { const b = e.target.closest("[data-k]"); if (!b) return; kindFilter = b.dataset.k; renderChips(); renderList(); };
$("tagChips").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; tagFilter = tagFilter === b.dataset.t ? null : b.dataset.t; renderChips(); renderList(); };

function thumbHtml(it) {
  const u = urls[thumbOf(it)] || it.og_image;
  return u ? `<div class="th" style="background-image:url('${esc(u)}')"></div>` : `<div class="th">${GLYPH[it.kind] || ""}</div>`;
}
function itemHtml(it) {
  const cls = it.status === "processing" ? "proc" : it.status === "error" ? "err" : "";
  const meta = it.status === "processing" ? `<span class="spin"></span> 整理中…` : it.status === "error" ? `保存に失敗：${esc(it.error || "")}` : `${KIND[it.kind] || ""}・${esc(it.site || "")} ${fmtDate(it.created_at)}`;
  return `<button class="item ${cls}" data-id="${it.id}">${thumbHtml(it)}<div class="bd">
    <h3>${esc(it.title || it.url || "（無題）")}</h3><div class="meta">${meta}</div>
    ${it.summary ? `<div class="sm">${esc(it.summary)}</div>` : ""}
    ${(it.tags || []).length ? `<div class="tags">${it.tags.slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
  </div></button>`;
}
function renderList() {
  let list = shown ?? items;
  if (kindFilter !== "all") list = list.filter(i => i.kind === kindFilter);
  if (tagFilter) list = list.filter(i => (i.tags || []).includes(tagFilter));
  $("list").innerHTML = list.length ? list.map(itemHtml).join("")
    : `<div class="empty">${shown ? "見つかりませんでした。" : "まだ何もありません。<br>右下の＋か、iPhoneの共有ボタンから保存できます。"}</div>`;
}
$("list").onclick = e => { const b = e.target.closest("[data-id]"); if (b) openDetail(b.dataset.id); };

/* ---------- 検索・質問 ---------- */
$("askToggle").onclick = () => {
  askMode = !askMode;
  $("askToggle").classList.toggle("on", askMode);
  $("q").placeholder = askMode ? "保存したものに質問（例：五苓散の論文の結論は？）" : "意味で探す（例：睡眠に効く漢方の論文）";
  $("q").focus();
};
$("q").addEventListener("input", () => { if (!$("q").value.trim() && (shown || $("answer").innerHTML)) { shown = null; $("answer").innerHTML = ""; renderList(); } });
$("searchForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  $("q").blur();
  if (askMode) {
    $("answer").innerHTML = `<div class="answer"><span class="spin"></span> 保存したものを読んでいます…</div>`;
    try {
      const r = await call("ask", { q });
      $("answer").innerHTML = `<div class="answer">${esc(r.answer)}${r.sources?.length ? `<div class="srcs">${r.sources.map(s => `<button data-src="${s.id}">[${s.n}] ${esc(s.title)}</button>`).join("")}</div>` : ""}</div>`;
    } catch (err) { $("answer").innerHTML = `<div class="answer">${esc(err.message)}</div>`; }
    return;
  }
  $("list").innerHTML = `<div class="empty"><span class="spin"></span> 探しています…</div>`;
  try {
    const r = await call("search", { q });
    shown = r.items || [];
    await ensureUrls(shown.map(thumbOf));
    renderList();
  } catch (err) { toast(err.message); shown = null; renderList(); }
};
$("answer").onclick = e => { const b = e.target.closest("[data-src]"); if (b) openDetail(b.dataset.src); };

/* ---------- 追加 ---------- */
function resetAdd() {
  $("addText").value = ""; $("addMemo").value = ""; addFiles = { imgs: [], pdf: null };
  $("addImg").value = ""; $("addPdf").value = ""; $("addPrev").innerHTML = "";
}
function renderAddPrev() {
  $("addPrev").innerHTML = [...addFiles.imgs.map(f => `<span>🖼 ${esc(f.name)}</span>`), addFiles.pdf ? `<span>📄 ${esc(addFiles.pdf.name)}</span>` : ""].join("");
}
$("addImg").onchange = e => { addFiles.imgs = [...e.target.files]; renderAddPrev(); };
$("addPdf").onchange = e => { addFiles.pdf = e.target.files[0] || null; renderAddPrev(); };
$("fab").onclick = () => {
  if (!$("canvasView").classList.contains("hidden")) { addTilePrompt(); return; }
  resetAdd(); openSheet("addSheet"); setTimeout(() => $("addText").focus(), 50);
};

// 保存中の仮カードを先頭に出しておく
function placeholder(title) {
  const it = { id: "tmp-" + uid(), kind: "web", title, status: "processing", tags: [], created_at: new Date().toISOString() };
  items.unshift(it); renderList(); return it;
}
function dropPlaceholder(it) { items = items.filter(i => i !== it); }

async function saveOne(payload, label) {
  const ph = placeholder(label);
  try {
    const r = await call("ingest", payload);
    dropPlaceholder(ph);
    toast(r.duplicate ? `保存済みです：${r.title || ""}` : `保存しました：${r.title || ""}`);
  } catch (err) { dropPlaceholder(ph); toast("保存できませんでした：" + err.message, 4000); }
}
$("addGo").onclick = async () => {
  const text = $("addText").value.trim(), memo = $("addMemo").value.trim();
  const imgs = addFiles.imgs, pdf = addFiles.pdf;
  if (!text && !imgs.length && !pdf) { toast("URLかメモを入れるか、ファイルを選んでください"); return; }
  closeSheet("addSheet");
  const jobs = [];
  for (const f of imgs) {
    jobs.push((async () => {
      const blob = await shrink(f, 1600), thumb = await shrink(f, 360, 0.72), id = uid();
      const path = `${user.id}/${id}.jpg`, tpath = `${user.id}/${id}_t.jpg`;
      const opt = { contentType: "image/jpeg", cacheControl: "604800" };
      const [a, b] = await Promise.all([sb.storage.from(BUCKET).upload(path, blob, opt), sb.storage.from(BUCKET).upload(tpath, thumb, opt)]);
      if (a.error || b.error) { toast("写真をアップロードできませんでした"); return; }
      await saveOne({ image_path: path, thumb_path: tpath, mime: "image/jpeg", text: imgs.length === 1 ? text : "", memo }, f.name);
    })());
  }
  if (pdf) {
    if (pdf.size > 10 * 1024 * 1024) toast("PDFは10MBまでです");
    else jobs.push((async () => saveOne({ pdf: await blobToBase64(pdf), filename: pdf.name, memo }, pdf.name))());
  }
  if (text && !(imgs.length === 1)) {
    // 複数行に URL が並んでいたら1件ずつ保存
    const urlsIn = text.match(/https?:\/\/[^\s<>"]+/g) || [];
    if (urlsIn.length > 1) urlsIn.forEach(u => jobs.push(saveOne({ url: u, memo }, u)));
    else jobs.push(saveOne({ text, memo }, text.slice(0, 60)));
  }
  await Promise.all(jobs);
  await loadItems();
};

/* ---------- 詳細 ---------- */
async function openDetail(id) {
  let it = items.find(i => i.id === id) || shown?.find(i => i.id === id);
  if (!it) { const { data } = await sb.from("stash_items").select(COLS).eq("id", id).maybeSingle(); it = data; }
  if (!it) return;
  current = it;
  await ensureUrls([it.image_path, it.file_path]);
  const hero = urls[it.image_path] || it.og_image;
  const onCanvas = tiles.some(t => t.item_id === it.id || t.url === it.url);
  $("detailPane").innerHTML = `
    <div class="head"><span class="mu" style="font-size:13px">${KIND[it.kind] || ""}・${esc(it.site || "")} ${fmtDate(it.created_at)}</span><button class="x" data-close>閉じる</button></div>
    <h2>${esc(it.title || "（無題）")}</h2>
    ${it.author ? `<div class="kv">${esc(it.author)}</div>` : ""}
    ${hero ? `<img class="hero" src="${esc(hero)}" alt="">` : ""}
    ${it.status === "error" ? `<div class="sum" style="color:var(--warn)">保存に失敗しました：${esc(it.error || "")}</div>` : `<div class="sum">${esc(it.summary || "（要約なし）")}</div>`}
    ${it.url ? `<div class="kv"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.url)}</a></div>` : ""}
    <label class="l">タグ（読点かスペースで区切る）</label>
    <input class="field" id="dTags" value="${esc((it.tags || []).join("、"))}" style="margin-top:4px">
    <label class="l">メモ</label>
    <textarea class="field" id="dMemo" rows="3" style="margin-top:4px">${esc(it.memo || "")}</textarea>
    <button class="btn ghost" id="dSave">タグとメモを保存</button>
    <div class="acts">
      ${it.url ? `<a class="btn ac" href="${esc(it.url)}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">元のページを開く</a>` : ""}
      ${it.file_path ? `<a class="btn ac" href="${esc(urls[it.file_path] || "#")}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">PDFを開く</a>` : ""}
      ${it.url && it.kind !== "pdf" ? `<button class="btn ghost" id="dCanvas">${onCanvas ? "キャンバスで見る" : "キャンバスに置く"}</button>` : ""}
      <button class="btn ghost" id="dRedo">AIで整理し直す</button>
      <button class="btn danger" id="dDel">削除</button>
    </div>`;
  openSheet("detailSheet");
  $("dSave").onclick = async () => {
    const tags = [...new Set($("dTags").value.split(/[、,，\s]+/).map(s => s.replace(/^#/, "").trim()).filter(Boolean))];
    const memo = $("dMemo").value.trim() || null;
    const { error } = await sb.from("stash_items").update({ tags, memo, updated_at: new Date().toISOString() }).eq("id", it.id);
    if (error) { toast("保存できませんでした"); return; }
    Object.assign(it, { tags, memo }); renderChips(); renderList(); toast("保存しました");
    call("reembed", { id: it.id }).catch(() => {});
  };
  $("dRedo").onclick = async () => {
    closeSheet("detailSheet");
    const ph = placeholder(it.title || "整理し直し中");
    items = items.filter(i => i.id !== it.id);
    try { await call("reprocess", { id: it.id }); toast("整理し直しました"); }
    catch (err) { toast("できませんでした：" + err.message, 4000); }
    dropPlaceholder(ph); await loadItems();
  };
  $("dDel").onclick = async () => {
    if (!confirm(`「${it.title || "この項目"}」を削除します。元に戻せません。`)) return;
    const paths = [it.image_path, it.thumb_path, it.file_path].filter(Boolean);
    const { error } = await sb.from("stash_items").delete().eq("id", it.id);
    if (error) { toast("削除できませんでした"); return; }
    if (paths.length) sb.storage.from(BUCKET).remove(paths);
    items = items.filter(i => i.id !== it.id); if (shown) shown = shown.filter(i => i.id !== it.id);
    closeSheet("detailSheet"); renderChips(); renderList(); toast("削除しました");
  };
  const dc = $("dCanvas");
  if (dc) dc.onclick = async () => {
    closeSheet("detailSheet");
    const t = tiles.find(t => t.item_id === it.id || t.url === it.url);
    showTab("canvas");
    if (t) { focusTile(t); return; }
    await addTile(it.url, it.title, it.id);
  };
}

/* ---------- キャンバス ---------- */
const VIEW_KEY = "stash-view";
let view = (() => { try { return JSON.parse(localStorage.getItem(VIEW_KEY)) || { x: 20, y: 80, s: 0.6 }; } catch { return { x: 20, y: 80, s: 0.6 }; } })();
const world = $("world"), cv = $("canvasView");
function applyView() { world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`; }
function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} }
applyView();

async function loadTiles() {
  const { data, error } = await sb.from("stash_tiles").select("id,item_id,url,title,x,y,w,h,shot_path,prev_shot_path,shot_at,changes,changed_at,unseen,error,active,crop_y,watch_from,watch_to").order("created_at");
  if (error) { toast("キャンバスを読み込めませんでした"); return; }
  tiles = data || [];
  await ensureUrls(tiles.map(t => t.shot_path));
  renderTiles();
}
function tileHtml(t) {
  const img = urls[t.shot_path];
  const body = img ? `<div class="shot"><img src="${esc(img)}" alt="" draggable="false" style="transform:translateY(-${(t.crop_y || 0) * 100}%)"></div>`
    : `<div class="img">${t.error ? esc(t.error) : t.shot_at ? "スクショなし" : `<span><span class="spin"></span><br>撮影中…</span>`}</div>`;
  return `<div class="tile ${t.unseen ? "changed" : ""}" data-tile="${t.id}" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px">
    <div class="bar">${t.unseen ? `<span class="dot"></span>` : ""}<b>${esc(t.title || t.url)}</b><span class="when">${t.unseen ? "変化あり" : fmtWhen(t.shot_at)}</span></div>
    ${body}<div class="rz"></div></div>`;
}
function renderTiles() {
  world.innerHTML = tiles.length ? tiles.map(tileHtml).join("")
    : `<div style="position:absolute;left:40px;top:40px;width:520px;font-size:22px;line-height:1.8;color:var(--mu)">右下の＋でサイトのURLを追加すると、ここにスクショが並びます。<br>1日1回自動で撮り直し、文字が変わったサイトは赤枠になります。</div>`;
}
function tileEl(id) { return world.querySelector(`[data-tile="${id}"]`); }

function centerWorld() { return { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s }; }
async function addTile(url, title = null, itemId = null) {
  const c = centerWorld();
  const n = tiles.length;
  const row = { url, title, item_id: itemId, x: Math.round(c.x - 180 + (n % 3) * 24), y: Math.round(c.y - 130 + (n % 3) * 24), w: 360, h: 260 };
  const { data, error } = await sb.from("stash_tiles").insert(row).select("*").single();
  if (error) { toast("追加できませんでした：" + error.message); return; }
  tiles.push(data); renderTiles();
  toast("スクショを撮っています（20秒ほど）");
  try { await call("shoot", { ids: [data.id] }); } catch (err) { toast(err.message); }
  await loadTiles();
}
function addTilePrompt() {
  const u = prompt("キャンバスに置くサイトのURL");
  if (!u) return;
  const url = /^https?:\/\//.test(u.trim()) ? u.trim() : "https://" + u.trim();
  addTile(url);
}
function focusTile(t) {
  view.s = Math.min(1, Math.max(0.4, (innerWidth - 40) / t.w));
  view.x = innerWidth / 2 - (t.x + t.w / 2) * view.s;
  view.y = innerHeight / 2 - (t.y + t.h / 2) * view.s;
  applyView(); saveView();
}
$("fitBtn").onclick = () => {
  if (!tiles.length) { view = { x: 20, y: 80, s: 0.6 }; applyView(); return; }
  const x0 = Math.min(...tiles.map(t => t.x)), y0 = Math.min(...tiles.map(t => t.y));
  const x1 = Math.max(...tiles.map(t => t.x + t.w)), y1 = Math.max(...tiles.map(t => t.y + t.h));
  const s = Math.min(1.2, (innerWidth - 40) / (x1 - x0), (innerHeight - 160) / (y1 - y0));
  view = { s, x: (innerWidth - (x1 - x0) * s) / 2 - x0 * s, y: 70 + (innerHeight - 160 - (y1 - y0) * s) / 2 - y0 * s };
  applyView(); saveView();
};
$("shootAll").onclick = async () => {
  if (!tiles.length) return;
  const b = $("shootAll"); b.disabled = true; b.innerHTML = `<span class="spin"></span> 撮影中`;
  toast(`${tiles.length}件を撮り直しています。1件20秒ほどかかります`, 4000);
  try {
    const r = await call("shoot");
    const ch = (r.results || []).filter(x => x.changed).length, er = (r.results || []).filter(x => x.error).length;
    toast(`撮り直しました${ch ? `。${ch}件に変化あり` : ""}${er ? `（${er}件は失敗）` : ""}`, 3500);
  } catch (err) { toast(err.message); }
  b.disabled = false; b.textContent = "撮り直す";
  await loadTiles();
};

// ── 指・マウスの操作（背景：移動、2本指：拡大縮小、タイトル部分：タイルを動かす、右下：大きさを変える）──
const pts = new Map();
let g = null;
const W = (cx, cy) => ({ x: (cx - view.x) / view.s, y: (cy - view.y) / view.s });
cv.addEventListener("pointerdown", e => {
  if (e.target.closest(".ctools")) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cv.setPointerCapture(e.pointerId);
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    g = { mode: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), c0: W((a.x + b.x) / 2, (a.y + b.y) / 2), s0: view.s, moved: true };
    return;
  }
  const tEl = e.target.closest(".tile");
  const t = tEl && tiles.find(x => x.id === tEl.dataset.tile);
  if (t && e.target.closest(".rz")) g = { mode: "resize", t, el: tEl, sx: e.clientX, sy: e.clientY, w0: t.w, h0: t.h, moved: false };
  else if (t && e.target.closest(".bar")) g = { mode: "drag", t, el: tEl, sx: e.clientX, sy: e.clientY, x0: t.x, y0: t.y, moved: false };
  else g = { mode: "pan", t, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
});
cv.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId) || !g) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.mode === "pinch" && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    view.s = Math.min(2.5, Math.max(0.15, g.s0 * d / g.d0));
    view.x = cx - g.c0.x * view.s; view.y = cy - g.c0.y * view.s;
    applyView(); return;
  }
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
  if (g.mode === "pan") { view.x = g.vx + dx; view.y = g.vy + dy; applyView(); }
  else if (g.mode === "drag") { g.t.x = Math.round(g.x0 + dx / view.s); g.t.y = Math.round(g.y0 + dy / view.s); g.el.style.left = g.t.x + "px"; g.el.style.top = g.t.y + "px"; }
  else if (g.mode === "resize") { g.t.w = Math.max(200, Math.round(g.w0 + dx / view.s)); g.t.h = Math.max(150, Math.round(g.h0 + dy / view.s)); g.el.style.width = g.t.w + "px"; g.el.style.height = g.t.h + "px"; }
});
function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (!g) return;
  if (g.mode === "pinch") { if (pts.size === 0) { g = null; saveView(); } return; }
  const done = g; g = null;
  if (done.mode === "pan") { saveView(); if (!done.moved && done.t) openTile(done.t); }
  else if ((done.mode === "drag" || done.mode === "resize")) {
    if (!done.moved) { openTile(done.t); return; }
    sb.from("stash_tiles").update({ x: done.t.x, y: done.t.y, w: done.t.w, h: done.t.h }).eq("id", done.t.id).then(({ error }) => { if (error) toast("位置を保存できませんでした"); });
  }
}
cv.addEventListener("pointerup", endPointer);
cv.addEventListener("pointercancel", endPointer);
cv.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const p = W(e.clientX, e.clientY);
    view.s = Math.min(2.5, Math.max(0.15, view.s * Math.exp(-e.deltaY * 0.01)));
    view.x = e.clientX - p.x * view.s; view.y = e.clientY - p.y * view.s;
  } else { view.x -= e.deltaX; view.y -= e.deltaY; }
  applyView(); clearTimeout(saveView._t); saveView._t = setTimeout(saveView, 300);
}, { passive: false });
// iOS Safari のページ全体の拡大を止める
document.addEventListener("gesturestart", e => { if (!$("canvasView").classList.contains("hidden")) e.preventDefault(); });

async function openTile(t) {
  await ensureUrls([t.shot_path, t.prev_shot_path]);
  const ch = t.changes;
  const diff = ch && (ch.added?.length || ch.removed?.length)
    ? `<div class="diff">${(ch.added || []).map(l => `<div class="a">${esc(l)}</div>`).join("")}${(ch.removed || []).map(l => `<div class="d">${esc(l)}</div>`).join("")}</div>` : "";
  $("tilePane").innerHTML = `
    <div class="head"><span class="mu" style="font-size:13px">${t.shot_at ? `撮影：${fmtWhen(t.shot_at)}` : "未撮影"}${t.changed_at ? `・最後の変化：${fmtDate(t.changed_at)}` : ""}</span><button class="x" data-close>閉じる</button></div>
    <h2>${esc(t.title || t.url)}</h2>
    <div class="kv"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a></div>
    ${t.error ? `<div class="kv" style="color:var(--warn)">${esc(t.error)}</div>` : ""}
    ${t.prev_shot_path && urls[t.prev_shot_path] ? `<div class="seg" id="shotSeg"><button class="on" data-s="now">今回</button><button data-s="prev">前回</button></div>` : ""}
    ${urls[t.shot_path] ? `<img class="hero" id="tileImg" src="${esc(urls[t.shot_path])}" alt="">` : ""}
    ${diff ? `<label class="l">前回から変わった文字（${fmtDate(ch.at)}）</label>${diff}` : `<div class="kv">文字の変化は見つかっていません</div>`}
    <div class="kv">見張る範囲：${t.watch_from || t.watch_to ? `「${esc((t.watch_from || "最初").slice(0, 24))}」〜「${esc((t.watch_to || "最後").slice(0, 24))}」` : "ページ全体"}</div>
    <div class="acts">
      <a class="btn ac" href="${esc(t.url)}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">サイトを開く</a>
      <button class="btn ghost" id="tShoot">撮り直す</button>
      ${urls[t.shot_path] ? `<button class="btn ghost" id="tCrop">表示する位置を選ぶ</button>` : ""}
      <button class="btn ghost" id="tWatch">見張る範囲を選ぶ</button>
      ${!t.item_id && !items.some(i => i.url === t.url) ? `<button class="btn ghost" id="tStock">ストックにも保存</button>` : ""}
      <button class="btn danger" id="tDel">キャンバスから外す</button>
    </div>`;
  openSheet("tileSheet");
  if (t.unseen) {
    t.unseen = false;
    sb.from("stash_tiles").update({ unseen: false }).eq("id", t.id).then(() => {});
    const el = tileEl(t.id); if (el) el.outerHTML = tileHtml(t);
  }
  const seg = $("shotSeg");
  if (seg) seg.onclick = e => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    $("tileImg").src = urls[b.dataset.s === "prev" ? t.prev_shot_path : t.shot_path];
  };
  $("tShoot").onclick = async () => {
    const b = $("tShoot"); b.disabled = true; b.innerHTML = `<span class="spin"></span> 撮影中`;
    try { const r = await call("shoot", { ids: [t.id] }); const x = r.results?.[0]; toast(x?.error ? `一部失敗：${x.error}` : x?.changed ? "変化がありました" : "撮り直しました"); }
    catch (err) { toast(err.message); }
    closeSheet("tileSheet"); await loadTiles();
  };
  const tc = $("tCrop");
  if (tc) tc.onclick = () => pickCrop(t);
  $("tWatch").onclick = () => pickWatch(t);
  const st = $("tStock");
  if (st) st.onclick = async () => { closeSheet("tileSheet"); showTab("list"); await saveOne({ url: t.url }, t.title || t.url); await loadItems(); };
  $("tDel").onclick = async () => {
    if (!confirm("このサイトをキャンバスから外します。")) return;
    await sb.from("stash_tiles").delete().eq("id", t.id);
    const ps = [t.shot_path, t.prev_shot_path].filter(Boolean); if (ps.length) sb.storage.from(BUCKET).remove(ps);
    tiles = tiles.filter(x => x.id !== t.id); renderTiles(); closeSheet("tileSheet");
  };
}

// 表示する位置：ページ全体のスクショをスクロールして、タイルに出したいところで決める
function pickCrop(t) {
  $("tilePane").innerHTML = `
    <div class="head"><b>表示する位置を選ぶ</b><button class="x" data-close>閉じる</button></div>
    <p class="mu" style="font-size:13px;margin:0 0 8px">見たいところが枠の一番上に来るようにスクロールして「ここにする」を押してください。</p>
    <div id="cropBox" style="height:58vh;overflow:auto;border-radius:12px;border:2px solid var(--ac);background:var(--soft);-webkit-overflow-scrolling:touch">
      <img id="cropImg" src="${esc(urls[t.shot_path])}" style="width:100%;display:block" alt="">
    </div>
    <div class="row"><button class="btn ghost" id="cropTop">一番上に戻す</button><button class="btn ac" id="cropOk">ここにする</button></div>`;
  const box = $("cropBox"), img = $("cropImg");
  const go = () => { box.scrollTop = (t.crop_y || 0) * img.offsetHeight; };
  if (img.complete) go(); else img.onload = go;
  const save = async y => {
    t.crop_y = Math.max(0, Math.min(0.98, y));
    const { error } = await sb.from("stash_tiles").update({ crop_y: t.crop_y }).eq("id", t.id);
    if (error) { toast("保存できませんでした"); return; }
    const el = tileEl(t.id); if (el) el.outerHTML = tileHtml(t);
    closeSheet("tileSheet"); toast("表示する位置を変えました");
  };
  $("cropOk").onclick = () => save(img.offsetHeight ? box.scrollTop / img.offsetHeight : 0);
  $("cropTop").onclick = () => save(0);
}

// 見張る範囲：ページの文字の中から「ここから」「ここまで」の行を選ぶ
async function pickWatch(t) {
  const { data } = await sb.from("stash_tiles").select("last_text").eq("id", t.id).maybeSingle();
  const lines = (data?.last_text || "").split("\n").filter(Boolean).slice(0, 800);
  if (!lines.length) { toast("まだページの文字を取れていません。撮り直してからもう一度どうぞ"); return; }
  let a = t.watch_from ? lines.findIndex(l => l.includes(t.watch_from)) : -1;
  let b = t.watch_to ? lines.findIndex((l, k) => k >= Math.max(a, 0) && l.includes(t.watch_to)) : -1;
  $("tilePane").innerHTML = `
    <div class="head"><b>見張る範囲を選ぶ</b><button class="x" data-close>閉じる</button></div>
    <p class="mu" style="font-size:13px;margin:0 0 8px;line-height:1.7">ページの文字です。見張りたい部分の<b>最初の行</b>と<b>最後の行</b>をタップしてください。広告やランキングのように毎回変わる部分を外すと、関係ない「変化あり」が出なくなります。</p>
    <div id="wList" style="max-height:52vh;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)"></div>
    <div class="row"><button class="btn ghost" id="wAll">ページ全体にする</button><button class="btn ac" id="wOk">この範囲にする</button></div>`;
  const draw = () => {
    $("wList").innerHTML = lines.map((l, i) => {
      const inR = a >= 0 && i >= a && i <= (b >= 0 ? b : a);
      const mark = i === a ? "ここから " : i === b ? "ここまで " : "";
      return `<button data-i="${i}" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--soft);padding:7px 10px;font-size:13px;line-height:1.5;background:${inR ? "var(--acs)" : "none"}">${mark ? `<b style="color:var(--ac)">${mark}</b>` : ""}${esc(l.slice(0, 120))}</button>`;
    }).join("");
  };
  draw();
  const first = $("wList").querySelector(`[data-i="${Math.max(a, 0)}"]`); if (first && a > 2) first.scrollIntoView({ block: "center" });
  $("wList").onclick = e => {
    const btn = e.target.closest("[data-i]"); if (!btn) return;
    const i = +btn.dataset.i;
    if (a < 0 || b >= 0) { a = i; b = -1; } else if (i < a) { b = a; a = i; } else b = i;
    const keep = $("wList").scrollTop; draw(); $("wList").scrollTop = keep;
  };
  const save = async (from, to) => {
    const { error } = await sb.from("stash_tiles").update({ watch_from: from, watch_to: to, unseen: false, changes: null }).eq("id", t.id);
    if (error) { toast("保存できませんでした"); return; }
    Object.assign(t, { watch_from: from, watch_to: to, unseen: false, changes: null });
    const el = tileEl(t.id); if (el) el.outerHTML = tileHtml(t);
    closeSheet("tileSheet"); toast(from || to ? "この範囲だけ見張ります" : "ページ全体を見張ります");
  };
  $("wOk").onclick = () => { if (a < 0) { toast("最初の行をタップしてください"); return; } save(lines[a].slice(0, 80), lines[b >= 0 ? b : a].slice(0, 80)); };
  $("wAll").onclick = () => save(null, null);
}

/* ---------- タブ ---------- */
function showTab(name) {
  const canvas = name === "canvas";
  $("listView").classList.toggle("hidden", canvas);
  $("canvasView").classList.toggle("hidden", !canvas);
  $("tabList").classList.toggle("on", !canvas);
  $("tabCanvas").classList.toggle("on", canvas);
  $("fab").setAttribute("aria-label", canvas ? "サイトを追加" : "追加");
  try { localStorage.setItem("stash-tab", name); } catch {}
}
$("tabList").onclick = () => showTab("list");
$("tabCanvas").onclick = () => showTab("canvas");

/* ---------- 設定 ---------- */
$("openSettings").onclick = () => { $("endpoint").textContent = FN; openSheet("settingsSheet"); };
$("mkToken").onclick = async () => {
  if (!confirm("ショートカット用のキーを作ります。前に作ったキーは使えなくなります。")) return;
  try { const r = await call("token"); $("tokenVal").textContent = r.token; $("tokenBox").classList.remove("hidden"); }
  catch (err) { toast(err.message); }
};
$("copyToken").onclick = async () => { try { await navigator.clipboard.writeText($("tokenVal").textContent); toast("コピーしました"); } catch { toast("長押しでコピーしてください"); } };

/* ---------- ログイン ---------- */
let signUpMode = false;
$("authSwitch").onclick = () => {
  signUpMode = !signUpMode;
  $("authBtn").textContent = signUpMode ? "新規登録" : "ログイン";
  $("authSwitch").textContent = signUpMode ? "登録済みの方はログイン" : "はじめての方は新規登録";
  $("password").autocomplete = signUpMode ? "new-password" : "current-password";
};
$("authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value;
  $("authBtn").disabled = true;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split("#")[0].split("?")[0] } });
      if (error) throw error;
      if (!data.session) $("authMsg").textContent = "確認メールを送りました。メール内のリンクを開いたあと、ここに戻ってログインしてください。";
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    $("authMsg").textContent = String(err.message).includes("Invalid login") ? "メールアドレスかパスワードが違います。" : "エラー：" + err.message;
  } finally { $("authBtn").disabled = false; }
};
$("logout").onclick = async () => { closeSheet("settingsSheet"); await sb.auth.signOut(); };

// ?add=URL で開かれたら、そのまま保存する（ショートカットやブックマークから）
async function handleAddParam() {
  const p = new URLSearchParams(location.search);
  const add = p.get("add") || p.get("url") || p.get("text");
  if (!add) return;
  history.replaceState(null, "", location.pathname);
  showTab("list");
  await saveOne({ text: add }, add.slice(0, 60));
  await loadItems();
}

let authReady = false;
sb.auth.onAuthStateChange((_ev, session) => {
  const u = session?.user ?? null;
  if (authReady && u?.id === user?.id) return;
  authReady = true;
  user = u;
  $("auth").classList.toggle("hidden", !!user);
  $("app").classList.toggle("hidden", !user);
  if (user) {
    showTab(localStorage.getItem("stash-tab") === "canvas" ? "canvas" : "list");
    Promise.all([loadItems(), loadTiles()]).then(handleAddParam);
  } else { items = []; tiles = []; }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
