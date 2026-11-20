// ストック（stash）用 Edge Function
// ・保存：URL（記事・SNS・PDF）、写真・スクショ、PDFファイル、メモを受け取り、AIで要約・タグ付けして保存する
// ・検索：意味で探す（OpenAI の埋め込み）＋言葉で探す
// ・質問：保存したものをもとに AI が答える
// ・キャンバス：登録したサイトのスクショを撮り直し、文字の変化を調べる（1日1回 pg_cron から呼ばれる）
//
// 使う Secrets（ほかのアプリと共用・設定済み）:
//   ANTHROPIC_API_KEY … 要約・タグ付け・質問への回答
//   OPENAI_API_KEY    … 検索用の埋め込み
//   ALLOWED_EMAIL     … このアプリを使えるログイン用メールアドレス
// モデルは共通設定（app_settings: stash/summary_model, answer_model, embed_model）から読む

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(name: string, ...aliases: string[]): string {
  const wanted = new Set([name, ...aliases].map(norm));
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (wanted.has(norm(k))) return v.trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY", "CLAUDE_API_KEY");
const OPENAI_API_KEY = env("OPENAI_API_KEY", "OPENAI_KEY");
const ALLOWED_EMAIL = env("ALLOWED_EMAIL").toLowerCase();
const GOOGLE_PSI_KEY = env("GOOGLE_PSI_KEY", "PAGESPEED_API_KEY", "GOOGLE_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const BUCKET = "stash";
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-stash-token, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

// ── 共通設定 ──
let settingsCache: { at: number; map: Record<string, unknown> } | null = null;
async function setting(key: string, fallback: string): Promise<string> {
  if (!settingsCache || Date.now() - settingsCache.at > 60_000) {
    const map: Record<string, unknown> = {};
    const { data } = await admin.from("app_settings").select("app,key,value").in("app", ["global", "stash"]);
    for (const r of data ?? []) map[r.app === "global" ? `global.${r.key}` : r.key] = r.value;
    settingsCache = { at: Date.now(), map };
  }
  const v = settingsCache.map[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// ── ログイン確認（画面からはログインのトークン、ショートカットからは専用トークン）──
type Who = { id: string; client: SupabaseClient | null };
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function whoami(req: Request, body: Record<string, unknown>): Promise<Who> {
  const st = req.headers.get("x-stash-token") || (typeof body.token === "string" ? body.token : "");
  if (st) {
    const { data } = await admin.from("stash_tokens").select("user_id").eq("token_hash", await sha256(st)).maybeSingle();
    if (!data) throw new HttpError(401, "ショートカット用のキーが違います。アプリの設定で作り直してください");
    return { id: data.user_id, client: null };
  }
  if (!ALLOWED_EMAIL) throw new HttpError(500, "ALLOWED_EMAIL が設定されていません");
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "ログインしてください");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) throw new HttpError(401, "ログインの期限が切れました。もう一度ログインしてください");
  if ((data.user.email ?? "").toLowerCase() !== ALLOWED_EMAIL) throw new HttpError(403, "このアカウントでは使えません");
  const client = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  return { id: data.user.id, client };
}

// ── Claude ──
// deno-lint-ignore no-explicit-any
async function claude(model: string, content: any[], tool: any, system: string, maxTokens = 1500) {
  if (!ANTHROPIC_API_KEY) throw new HttpError(500, "ANTHROPIC_API_KEY が設定されていません");
  for (let i = 0; i < 3; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system,
        tools: [tool], tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content }],
      }),
    });
    if (r.ok) {
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      const t = (d.content ?? []).find((c: any) => c.type === "tool_use");
      if (t) return t.input;
      throw new HttpError(502, "AIの返事を読めませんでした");
    }
    const txt = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
    throw new HttpError(502, `AIエラー (${r.status}): ${txt.slice(0, 300)}`);
  }
  throw new HttpError(502, "AIが混み合っています。少し待ってもう一度お試しください");
}

// ── 埋め込み（検索用）──
async function embed(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY || !text.trim()) return null;
  const model = await setting("embed_model", "text-embedding-3-small");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text.slice(0, 8000), dimensions: 1536 }),
  });
  if (!r.ok) { console.error("embed", r.status, await r.text()); return null; }
  return (await r.json()).data?.[0]?.embedding ?? null;
}

// ── ページの取得 ──
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const BOT_UA = "Mozilla/5.0 (compatible; StashBot/1.0; +https://github.com/quruquruyuki/stash)";
async function fetchPage(url: string, ua = UA) {
  // 遅いサイトもあるので25秒まで待ち、時間切れなら1回だけやり直す
  for (let i = 0; ; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "ja,en;q=0.8" }, redirect: "follow", signal: ctl.signal });
      const type = r.headers.get("content-type") ?? "";
      const buf = new Uint8Array(await r.arrayBuffer());
      return { ok: r.ok, status: r.status, type, buf, finalUrl: r.url || url };
    } catch (e) {
      const timeout = ctl.signal.aborted || (e instanceof Error && /abort/i.test(e.name + e.message));
      if (timeout && i === 0) continue;
      throw new Error(timeout ? "ページの読み込みに時間がかかりすぎました" : `ページを開けませんでした（${e instanceof Error ? e.message : e}）`);
    } finally { clearTimeout(timer); }
  }
}
function decodeHtml(buf: Uint8Array, type: string) {
  let cs = /charset=([\w-]+)/i.exec(type)?.[1];
  if (!cs) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch { return new TextDecoder().decode(buf); }
}
const ent = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
function meta(html: string, ...names: string[]) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, "i");
    const m = re1.exec(html) || re2.exec(html);
    if (m && m[1].trim()) return ent(m[1].trim());
  }
  return "";
}
// 本文らしい文字だけを取り出す（行単位）
function htmlToText(html: string) {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ");
  const main = /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(h);
  if (main && main[0].length > 800) h = main[0];
  h = h.replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|dd|dt)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return ent(h).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).join("\n");
}
function siteOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function isSns(host: string) {
  return /(^|\.)(x\.com|twitter\.com|instagram\.com|threads\.net|threads\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|reddit\.com|bsky\.app|note\.com)$/.test(host);
}
function toB64(buf: Uint8Array) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}
function fromB64(b64: string) { const bin = atob(b64.replace(/^data:[^,]+,/, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

// URL から材料を集める
async function gatherUrl(url: string) {
  const host = siteOf(url);
  const out = { kind: isSns(host) ? "sns" : "web", title: "", site: host, author: "", text: "", og_image: "", pdf: null as Uint8Array | null };
  // X（旧Twitter）は oEmbed で本文が取れる
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) {
    try {
      const r = await fetch(`https://publish.twitter.com/oembed?omit_script=1&lang=ja&url=${encodeURIComponent(url.replace("x.com", "twitter.com"))}`);
      if (r.ok) {
        const d = await r.json();
        out.author = d.author_name ?? "";
        out.text = htmlToText(String(d.html ?? "").replace(/<a[^>]*>(pic\.twitter\.com[^<]*)<\/a>/g, ""));
        out.title = `${out.author}のポスト`;
        return out;
      }
    } catch (e) { console.error("oembed", e); }
  }
  // YouTube も oEmbed
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (r.ok) { const d = await r.json(); out.title = d.title ?? ""; out.author = d.author_name ?? ""; out.og_image = d.thumbnail_url ?? ""; }
    } catch { /* 下の通常取得に任せる */ }
  }
  let p = await fetchPage(url);
  // SNS は普通のブラウザ名だと中身が空のことがあるので、プレビュー用の名前で取り直す
  if (out.kind === "sns" && (!p.ok || !/og:/i.test(decodeHtml(p.buf.slice(0, 200000), p.type)))) {
    try { const q = await fetchPage(url, "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"); if (q.ok) p = q; } catch { /* そのまま */ }
  }
  if (/pdf/i.test(p.type) || /\.pdf($|\?)/i.test(url)) {
    if (p.buf.length > 0 && p.buf.length < 25 * 1024 * 1024) { out.kind = "pdf"; out.pdf = p.buf; out.title = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? ""); return out; }
  }
  if (!p.ok && !out.title) throw new HttpError(400, `ページを開けませんでした（${p.status}）。ログインが必要なページかもしれません`);
  const html = decodeHtml(p.buf, p.type);
  out.title ||= meta(html, "og:title", "twitter:title") || ent(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  out.site = meta(html, "og:site_name") || host;
  out.author ||= meta(html, "author", "article:author");
  out.og_image ||= meta(html, "og:image", "twitter:image");
  if (out.og_image && !/^https?:/i.test(out.og_image)) { try { out.og_image = new URL(out.og_image, p.finalUrl).href; } catch { out.og_image = ""; } }
  const desc = meta(html, "og:description", "description", "twitter:description");
  const body = htmlToText(html);
  out.text = [desc, body].filter(Boolean).join("\n").slice(0, 20000);
  return out;
}

// ── AI で要約・タグ付け ──
const SUMMARY_TOOL = {
  name: "save_item",
  description: "保存したものの整理結果を記録する",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "内容がわかる短いタイトル（日本語。元のタイトルが適切ならそのまま）" },
      summary: { type: "string", description: "あとで見返したときに役立つ要約。日本語で2〜4文。具体的な数字・固有名詞を残す" },
      tags: { type: "array", items: { type: "string" }, description: "3〜6個の短いタグ（日本語。例：漢方、論文、株、写真、釣り、レシピ、仕事、子ども）" },
      text: { type: "string", description: "写真・スクショ・PDFに書かれている文字のうち重要なもの（検索用。なければ空）" },
    },
    required: ["title", "summary", "tags"],
  },
};
const SYSTEM = "あなたはユーザーが保存した記事・SNS投稿・スクショ・論文を整理するアシスタントです。ユーザーは漢方薬メーカーのMR（医薬情報担当者）で、写真・釣り・株・英語・アプリ開発が趣味です。あとで検索して使いやすいように、要点とタグをつけてください。";

async function summarize(parts: { text?: string; image?: { b64: string; mime: string }; pdf?: Uint8Array; hint: string }) {
  const model = await setting("summary_model", "claude-haiku-5-5");
  // deno-lint-ignore no-explicit-any
  const content: any[] = [];
  if (parts.pdf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toB64(parts.pdf) } });
  if (parts.image) content.push({ type: "image", source: { type: "base64", media_type: parts.image.mime, data: parts.image.b64 } });
  content.push({ type: "text", text: `${parts.hint}\n\n${(parts.text ?? "").slice(0, 15000)}` });
  try {
    return await claude(model, content, SUMMARY_TOOL, SYSTEM);
  } catch (e) {
    // PDF が大きすぎるなどで断られたら、文字だけでもう一度
    if (parts.pdf && parts.text) return await claude(model, [{ type: "text", text: parts.hint + "\n\n" + parts.text.slice(0, 15000) }], SUMMARY_TOOL, SYSTEM);
    throw e;
  }
}

function cleanTags(t: unknown): string[] {
  return Array.isArray(t) ? [...new Set(t.map((x) => String(x).trim().replace(/^#/, "")).filter((x) => x && x.length <= 20))].slice(0, 8) : [];
}

// ── 保存 ──
// deno-lint-ignore no-explicit-any
async function ingest(who: Who, body: any) {
  let url = String(body.url ?? "").trim();
  let text = String(body.text ?? "").trim();
  // 共有メニューから「文章＋URL」がまとめて来たときは URL を取り出す
  if (!url && text) { const m = /https?:\/\/[^\s<>"]+/.exec(text); if (m) { url = m[0]; text = text.replace(m[0], "").trim(); } }
  const memo = String(body.memo ?? "").trim() || null;
  const image = body.image ? String(body.image) : "";
  const pdf = body.pdf ? String(body.pdf) : "";
  if (!url && !text && !image && !pdf && !body.image_path) throw new HttpError(400, "保存するものがありません");

  if (url) {
    const { data: dup } = await admin.from("stash_items").select("id,title").eq("user_id", who.id).eq("url", url).maybeSingle();
    if (dup && !body.force) return { ok: true, id: dup.id, duplicate: true, title: dup.title };
  }

  const kind = pdf ? "pdf" : image || body.image_path ? "image" : url ? "web" : "note";
  const { data: row, error } = await admin.from("stash_items").insert({ user_id: who.id, kind, url: url || null, memo, title: body.title || null, status: "processing" }).select("id").single();
  if (error) throw new HttpError(500, error.message);
  const id = row.id;

  try {
    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = {};
    let aiText = text;
    let aiImage: { b64: string; mime: string } | undefined;
    let aiPdf: Uint8Array | undefined;
    let hint = "";

    if (image || body.image_path) {
      let bytes: Uint8Array;
      let mime = String(body.mime ?? "image/jpeg");
      if (image) bytes = fromB64(image);
      else {
        const { data: f, error: e } = await admin.storage.from(BUCKET).download(String(body.image_path));
        if (e || !f) throw new HttpError(400, "写真を読み込めませんでした");
        bytes = new Uint8Array(await f.arrayBuffer()); mime = f.type || mime;
      }
      if (bytes.length > 5 * 1024 * 1024) throw new HttpError(400, "写真が大きすぎます（5MBまで）");
      if (!/^image\/(jpeg|png|gif|webp)$/.test(mime)) mime = "image/jpeg";
      if (body.image_path) patch.image_path = String(body.image_path);
      else {
        const path = `${who.id}/${id}.${mime.split("/")[1].replace("jpeg", "jpg")}`;
        await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
        patch.image_path = path;
      }
      if (body.thumb_path) patch.thumb_path = String(body.thumb_path);
      aiImage = { b64: toB64(bytes), mime };
      hint = "この写真・スクリーンショットの内容を整理してください。" + (text ? `\nユーザーのコメント：${text}` : "");
    } else if (pdf) {
      const bytes = fromB64(pdf);
      if (bytes.length > 25 * 1024 * 1024) throw new HttpError(400, "PDFが大きすぎます（25MBまで）");
      const path = `${who.id}/${id}.pdf`;
      await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      patch.file_path = path;
      aiPdf = bytes;
      hint = "このPDF（論文・資料など）の内容を整理してください。論文なら著者・雑誌・年・結論を要約に入れてください。" + (body.filename ? `\nファイル名：${body.filename}` : "");
      patch.title = body.filename ? String(body.filename).replace(/\.pdf$/i, "") : null;
    } else if (url) {
      const g = await gatherUrl(url);
      patch.kind = g.kind; patch.site = g.site; patch.author = g.author || null; patch.og_image = g.og_image || null;
      patch.title = body.title || g.title || null;
      if (g.pdf) {
        const path = `${who.id}/${id}.pdf`;
        await admin.storage.from(BUCKET).upload(path, g.pdf, { contentType: "application/pdf", upsert: true });
        patch.file_path = path; aiPdf = g.pdf;
        hint = `このPDF（${url}）の内容を整理してください。論文なら著者・雑誌・年・結論を要約に入れてください。`;
      } else {
        aiText = [text && `ユーザーのコメント：${text}`, g.text].filter(Boolean).join("\n");
        hint = `次の${g.kind === "sns" ? "SNS投稿" : "Webページ"}を整理してください。\nURL：${url}\nタイトル：${g.title}\nサイト：${g.site}${g.author ? `\n投稿者：${g.author}` : ""}`;
        if (!g.text.trim()) hint += "\n（本文を取得できませんでした。タイトルとURLから推測できる範囲で整理し、要約にその旨を書いてください）";
      }
    } else {
      hint = "次のメモを整理してください。";
    }

    const ai = await summarize({ text: aiText, image: aiImage, pdf: aiPdf, hint });
    patch.title = (patch.title && patch.kind !== "sns" ? patch.title : null) || ai.title || patch.title || "（無題）";
    patch.summary = ai.summary ?? null;
    patch.tags = cleanTags(ai.tags);
    patch.content = [aiText, ai.text].filter(Boolean).join("\n").slice(0, 20000) || null;
    const emb = await embed([patch.title, patch.summary, patch.tags.join(" "), memo, (patch.content ?? "").slice(0, 4000)].filter(Boolean).join("\n"));
    if (emb) patch.embedding = JSON.stringify(emb);
    patch.status = "ready"; patch.error = null; patch.updated_at = new Date().toISOString();
    await admin.from("stash_items").update(patch).eq("id", id);
    return { ok: true, id, title: patch.title, summary: patch.summary, tags: patch.tags };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("stash_items").update({ status: "error", error: msg.slice(0, 500), title: body.title || url || "（保存失敗）" }).eq("id", id);
    throw e;
  }
}

// 失敗したもの・メモを書き換えたものを整理し直す
async function reprocess(who: Who, id: string) {
  const { data: it } = await admin.from("stash_items").select("*").eq("id", id).eq("user_id", who.id).maybeSingle();
  if (!it) throw new HttpError(404, "見つかりません");
  await admin.from("stash_items").delete().eq("id", id);
  return await ingest(who, { url: it.url, text: it.kind === "note" ? it.content : "", memo: it.memo, image_path: it.image_path, thumb_path: it.thumb_path, force: true });
}

// メモやタグを手で直したあと、検索用の埋め込みだけ作り直す
async function reembed(who: Who, id: string) {
  const { data: it } = await admin.from("stash_items").select("title,summary,tags,memo,content").eq("id", id).eq("user_id", who.id).maybeSingle();
  if (!it) throw new HttpError(404, "見つかりません");
  const emb = await embed([it.title, it.summary, (it.tags ?? []).join(" "), it.memo, (it.content ?? "").slice(0, 4000)].filter(Boolean).join("\n"));
  if (emb) await admin.from("stash_items").update({ embedding: JSON.stringify(emb), updated_at: new Date().toISOString() }).eq("id", id);
  return { ok: true };
}

// ── 検索 ──
const LIST_COLS = "id,kind,url,title,site,author,summary,tags,memo,og_image,image_path,thumb_path,file_path,status,error,pinned,created_at";
async function search(who: Who, q: string, n = 30) {
  q = q.trim();
  if (!q) return { items: [] };
  const [emb, kw] = await Promise.all([
    embed(q),
    admin.from("stash_items").select(LIST_COLS).eq("user_id", who.id)
      .or(["title", "summary", "memo", "content", "site", "author"].map((c) => `${c}.ilike.%${q.replace(/[%,()]/g, " ")}%`).join(","))
      .order("created_at", { ascending: false }).limit(n),
  ]);
  const scores = new Map<string, number>();
  for (const r of kw.data ?? []) scores.set(r.id, 0.6);
  if (emb) {
    const { data } = await admin.rpc("stash_match_admin", { uid: who.id, q: JSON.stringify(emb), n });
    // deno-lint-ignore no-explicit-any
    for (const r of (data ?? []) as any[]) if (r.score > 0.2) scores.set(r.id, Math.max(scores.get(r.id) ?? 0, r.score) + (scores.has(r.id) ? 0.2 : 0));
  }
  const ids = [...scores.keys()];
  if (!ids.length) return { items: [] };
  const { data: rows } = await admin.from("stash_items").select(LIST_COLS).in("id", ids);
  const items = (rows ?? []).sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, n);
  return { items };
}

// ── 質問に答える ──
const ANSWER_TOOL = {
  name: "answer",
  description: "保存したものをもとに答える",
  input_schema: {
    type: "object",
    properties: {
      answer: { type: "string", description: "日本語の答え。根拠にした資料は [1] [2] のように番号で示す。保存したものに答えがなければ正直にそう書く" },
      used: { type: "array", items: { type: "integer" }, description: "根拠にした資料の番号" },
    },
    required: ["answer", "used"],
  },
};
async function ask(who: Who, q: string) {
  const { items } = await search(who, q, 10);
  const ids = items.map((i) => i.id);
  const { data: full } = ids.length ? await admin.from("stash_items").select("id,title,url,site,summary,tags,memo,content,created_at").in("id", ids) : { data: [] };
  const byId = new Map((full ?? []).map((r) => [r.id, r]));
  const docs = ids.map((id) => byId.get(id)).filter(Boolean);
  if (!docs.length) return { answer: "関係しそうな保存物が見つかりませんでした。別の言葉で聞いてみてください。", sources: [] };
  const ctx = docs.map((d, i) => `[${i + 1}] ${d!.title}（${d!.site ?? ""} ${String(d!.created_at).slice(0, 10)}）\n要約：${d!.summary ?? ""}\nタグ：${(d!.tags ?? []).join("、")}${d!.memo ? `\nメモ：${d!.memo}` : ""}\n本文抜粋：${(d!.content ?? "").slice(0, 2500)}`).join("\n\n---\n\n");
  const model = await setting("answer_model", "claude-sonnet-5-5");
  const r = await claude(model, [{ type: "text", text: `質問：${q}\n\n以下はユーザーが保存した資料です。\n\n${ctx}` }], ANSWER_TOOL,
    "あなたはユーザーが保存した資料だけを根拠に答えるアシスタントです。資料にないことは推測せず、ないと伝えてください。簡潔に、スマホで読みやすく答えてください。", 1500);
  const used = Array.isArray(r.used) ? r.used.map(Number).filter((n: number) => n >= 1 && n <= docs.length) : [];
  return { answer: r.answer, sources: used.map((n: number) => ({ n, id: docs[n - 1]!.id, title: docs[n - 1]!.title, url: docs[n - 1]!.url })) };
}

// ── ショートカット用のキー ──
async function newToken(who: Who) {
  const raw = "stk_" + [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await admin.from("stash_tokens").upsert({ user_id: who.id, token_hash: await sha256(raw), created_at: new Date().toISOString() });
  return { token: raw };
}

// ── キャンバス：スクショ撮影と変化の検出 ──
function linesOf(text: string) {
  return text.split("\n").map((l) => l.trim())
    // 日付・時刻・アクセス数のように毎回変わる行は比べない
    .filter((l) => l.length >= 2 && !/^[\d\s:\/.\-年月日時分秒（）()曜]+$/.test(l));
}
// 見張る範囲（「ここから」「ここまで」の行）だけを取り出す
function watchSlice(lines: string[], from?: string | null, to?: string | null) {
  let a = 0, b = lines.length;
  if (from) { const i = lines.findIndex((l) => l.includes(from)); if (i >= 0) a = i; }
  if (to) { const j = lines.findIndex((l, k) => k >= a && l.includes(to)); if (j >= 0) b = j + 1; }
  return lines.slice(a, b);
}
// 1枚のページ全体のスクショを撮る（microlink の無料枠 → だめなら Google PageSpeed Insights）
// どちらでも撮れずサイトに断られたときは BLOCKED を投げる（そのタイルは文字で表示する）
const BLOCKED = "BLOCKED";
async function microlink(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const api = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&fullPage=true&meta=true&viewport.width=1280&viewport.height=900&viewport.deviceScaleFactor=1&waitUntil=networkidle2&type=jpeg`;
  const r = await fetch(api);
  // deno-lint-ignore no-explicit-any
  const d: any = await r.json().catch(() => ({}));
  const title = String(d?.data?.title ?? "");
  const code = Number(d?.statusCode ?? 0);
  if (code >= 400 || /^(403|forbidden|access denied|attention required|just a moment|アクセスが拒否)/i.test(title.trim())) throw new Error(BLOCKED);
  const shot = d?.data?.screenshot?.url;
  if (!shot) throw new Error(d?.message || `スクショを撮れませんでした（${r.status}）`);
  const img = await fetch(shot);
  if (!img.ok) throw new Error("スクショを保存できませんでした");
  return { bytes: new Uint8Array(await img.arrayBuffer()), type: img.headers.get("content-type") || "image/jpeg" };
}
// Google PageSpeed Insights（自分のAPIキーがあるときだけ使う。キーなしは世界中で共用の枠なのですぐ尽きる）
async function pagespeed(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?category=performance&strategy=desktop&key=${encodeURIComponent(GOOGLE_PSI_KEY)}&url=${encodeURIComponent(url)}`);
  // deno-lint-ignore no-explicit-any
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PageSpeed：${d?.error?.message ?? r.status}`);
  const a = d?.lighthouseResult?.fullPageScreenshot?.screenshot?.data || d?.lighthouseResult?.audits?.["final-screenshot"]?.details?.data;
  if (typeof a !== "string" || !a.startsWith("data:")) throw new Error("PageSpeed：スクショが返ってきませんでした");
  return { bytes: fromB64(a), type: a.slice(5, a.indexOf(";")) || "image/jpeg" };
}
async function screenshot(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  try { return await microlink(url); }
  catch (e) {
    if (!GOOGLE_PSI_KEY) throw e;
    try { return await pagespeed(url); }
    catch (e2) {
      console.error("pagespeed", e2);
      throw e; // microlink で断られていれば BLOCKED のまま（文字表示に切り替わる）
    }
  }
}
// deno-lint-ignore no-explicit-any
async function shootTile(t: any) {
  const now = new Date().toISOString();
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = { shot_at: now, error: null };
  // 1) 文字を取って前回と比べる（見張る範囲が決まっていればその中だけ）
  try {
    const p = await fetchPage(t.url);
    if (!p.ok) throw new Error(`ページを開けませんでした（${p.status}）`);
    const html = decodeHtml(p.buf, p.type);
    if (!t.title) patch.title = meta(html, "og:title") || ent(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "") || siteOf(t.url);
    const lines = linesOf(htmlToText(html));
    const text = lines.join("\n").slice(0, 60000);
    if (t.last_text) {
      const before = watchSlice(linesOf(t.last_text), t.watch_from, t.watch_to);
      const after = watchSlice(lines, t.watch_from, t.watch_to);
      const bs = new Set(before), as = new Set(after);
      const added = after.filter((l) => !bs.has(l)).slice(0, 40);
      const removed = before.filter((l) => !as.has(l)).slice(0, 40);
      if (added.length || removed.length) { patch.changes = { added, removed, at: now }; patch.changed_at = now; patch.unseen = true; }
    }
    patch.text_hash = await sha256(text); patch.last_text = text;
    patch.excerpt = watchSlice(lines, t.watch_from, t.watch_to).slice(0, 80).join("\n").slice(0, 4000);
  } catch (e) { patch.error = e instanceof Error ? e.message : String(e); }
  // 2) ページ全体のスクショ（文字で表示するタイルは撮らない＝無料枠の節約）
  if (t.view_mode !== "text") try {
    const { bytes, type } = await screenshot(t.url);
    const path = `${t.user_id}/tiles/${t.id}-${Date.now()}.${type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg"}`;
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type });
    if (error) throw error;
    // 1つ前のスクショだけ残す（変化の見比べ用）。それより古いものは消す
    if (t.prev_shot_path) await admin.storage.from(BUCKET).remove([t.prev_shot_path]);
    patch.prev_shot_path = t.shot_path ?? null;
    patch.shot_path = path;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m === BLOCKED) patch.view_mode = "text"; // スクショを断るサイトは文字で表示する
    else patch.error = patch.error ? `${patch.error} / ${m}` : m;
  }
  await admin.from("stash_tiles").update(patch).eq("id", t.id);
  return { id: t.id as string, error: (patch.error ?? null) as string | null, changed: !!patch.changes };
}
async function shoot(who: Who | null, ids?: string[]) {
  let q = admin.from("stash_tiles").select("*").eq("active", true);
  if (who) q = q.eq("user_id", who.id);
  if (ids?.length) q = q.in("id", ids);
  const { data: tiles } = await q.order("shot_at", { ascending: true, nullsFirst: true }).limit(40);
  const results = [];
  for (const t of tiles ?? []) results.push(await shootTile(t)); // 無料枠の混雑を避けて1件ずつ
  return { results };
}

// 自動撮影：前回から20時間以上たったタイルを3件ずつ撮る（関数の時間制限に収めるため。cron が5分おきに呼ぶ）
async function shootDue() {
  const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const { data: tiles } = await admin.from("stash_tiles").select("*").eq("active", true)
    .or(`shot_at.is.null,shot_at.lt.${since}`).order("shot_at", { ascending: true, nullsFirst: true }).limit(3);
  const results = [];
  for (const t of tiles ?? []) results.push(await shootTile(t));
  return { results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json().catch(() => ({}));

    // 1日1回の自動撮影（pg_cron から）
    if (body.action === "cron") {
      const secret = req.headers.get("x-cron-secret") ?? "";
      const { data } = await admin.from("stash_cron").select("secret").limit(1).maybeSingle();
      if (!secret || !data || data.secret !== secret) throw new HttpError(401, "unauthorized");
      return json(await shootDue());
    }

    const who = await whoami(req, body);
    switch (body.action ?? "ingest") {
      case "ingest": return json(await ingest(who, body));
      case "reprocess": return json(await reprocess(who, String(body.id)));
      case "reembed": return json(await reembed(who, String(body.id)));
      case "search": return json(await search(who, String(body.q ?? "")));
      case "ask": return json(await ask(who, String(body.q ?? "")));
      case "token": if (!who.client) throw new HttpError(403, "アプリから操作してください"); return json(await newToken(who));
      case "shoot": return json(await shoot(who, Array.isArray(body.ids) ? body.ids.map(String) : undefined));
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
