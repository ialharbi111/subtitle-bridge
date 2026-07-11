"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 7000);
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";
const DEFAULT_LANGUAGES = (process.env.SUBTITLE_LANGUAGES || "AR")
  .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
const ENABLE_OPEN_SUBTITLES = process.env.ENABLE_OPEN_SUBTITLES !== "false";
const ENABLE_SUBDL = Boolean(SUBDL_API_KEY) && process.env.ENABLE_SUBDL !== "false";
const HIDE_HI = process.env.HIDE_HI === "true";

const LANGUAGE_OPTIONS = [
  { code: "AR", label: "العربية / Arabic" },
  { code: "EN", label: "English" },
  { code: "FR", label: "Français" },
  { code: "ES", label: "Español" },
  { code: "PT", label: "Português" }
];

function baseManifest(languages) {
  const label = languages.join("+");
  return {
    id: `com.personal.subtitlebridge.${label.toLowerCase()}`,
    version: "2.1.0",
    name: `Subtitle Bridge (${label})`,
    description: `ترجمات من OpenSubtitles وSubDL — لغات: ${label}`,
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(JSON.stringify(data));
}

function html(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function parseVideoId(id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+))?(?::(\d+))?$/i);
  return match ? { imdbId: match[1], season: match[2], episode: match[3] } : null;
}

function language(code) {
  const value = String(code || "").trim().toUpperCase();
  const map = { ARA: "AR", ARB: "AR", ENG: "EN", FRE: "FR", FRA: "FR", SPA: "ES", POR: "PT" };
  return map[value] || value;
}

function stremioLanguage(code) {
  const value = language(code);
  const map = { AR: "ara", EN: "eng", FR: "fra", ES: "spa", PT: "por" };
  return map[value] || String(code || "und").toLowerCase();
}

function safeText(value) {
  return String(value || "").slice(0, 180).replace(/[\r\n]+/g, " ");
}

// --- config encoding: base64url JSON in the URL path, e.g. /eyJsYW5n.../manifest.json ---
function decodeConfig(segment) {
  try {
    const data = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (Array.isArray(data.languages) && data.languages.length) {
      return data.languages.map((value) => String(value).trim().toUpperCase()).filter(Boolean);
    }
  } catch (error) {
    // fall through
  }
  return null;
}

// Stremio's real clients append video info (filename/videoSize/videoHash) as an extra
// PATH segment before ".json" -- e.g. /subtitles/movie/tt123/filename=X.mp4.json
// (not as a "?query=string"). We must parse it from there, with a query-string fallback
// for the older format / manual testing.
function parseExtra(segment, searchParams) {
  const merged = new URLSearchParams();
  if (segment) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch (error) { /* keep raw */ }
    for (const [key, value] of new URLSearchParams(decoded)) merged.set(key, value);
  }
  for (const [key, value] of searchParams) merged.set(key, value);
  return merged;
}

function releaseScore(releaseName, filename, source) {
  const release = String(releaseName || "").toLowerCase();
  const file = String(filename || "").toLowerCase();
  let score = source === "SubDL" ? 4 : 2;
  if (!release || !file) return score;
  for (const token of release.split(/[^a-z0-9]+/).filter((token) => token.length >= 3)) {
    if (file.includes(token)) score += 3;
  }
  for (const marker of ["2160p", "1080p", "720p", "web-dl", "webdl", "webrip", "bluray", "x265", "x264"]) {
    if (release.includes(marker) && file.includes(marker)) score += 8;
  }
  return score;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function openSubtitles(type, id, extra, languages) {
  if (!ENABLE_OPEN_SUBTITLES) return [];
  const upstream = new URL(`https://opensubtitles-v3.strem.io/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  for (const [key, value] of extra) upstream.searchParams.set(key, value);
  const data = await fetchJson(upstream);
  return (data.subtitles || [])
    .filter((item) => languages.includes(language(item.lang)))
    .map((item, index) => ({
      id: `os-${item.id || index}`,
      url: item.url,
      lang: stremioLanguage(item.lang),
      langRaw: item.lang,
      source: "OpenSubtitles",
      release: item.id || "",
      score: releaseScore(item.id, extra.get("filename"), "OpenSubtitles")
    }));
}

async function subdl(type, id, extra, languages) {
  if (!ENABLE_SUBDL) return [];
  const video = parseVideoId(id);
  if (!video) return [];
  const upstream = new URL("https://api.subdl.com/api/v1/subtitles");
  upstream.searchParams.set("api_key", SUBDL_API_KEY);
  upstream.searchParams.set("imdb_id", video.imdbId);
  upstream.searchParams.set("type", type === "series" ? "tv" : "movie");
  upstream.searchParams.set("languages", languages.join(","));
  upstream.searchParams.set("subs_per_page", "30");
  upstream.searchParams.set("unpack", "1");
  upstream.searchParams.set("releases", "1");
  upstream.searchParams.set("hi", "1");
  if (video.season) upstream.searchParams.set("season_number", video.season);
  if (video.episode) upstream.searchParams.set("episode_number", video.episode);
  const data = await fetchJson(upstream);
  if (!data.status) return [];
  const output = [];
  for (const subtitle of data.subtitles || []) {
    for (const file of subtitle.unpack_files || []) {
      if (!file.url || !languages.includes(language(file.language)) || (HIDE_HI && file.hi)) continue;
      if (video.episode && file.episode && Number(file.episode) !== Number(video.episode)) continue;
      const url = file.url.startsWith("http") ? file.url : `https://dl.subdl.com${file.url}`;
      const release = file.release_name || subtitle.release_name || file.name;
      output.push({
        id: `subdl-${file.file_n_id || file.md5 || output.length}`,
        url,
        lang: stremioLanguage(file.language),
        langRaw: file.language,
        source: "SubDL",
        release,
        score: releaseScore(release, extra.get("filename"), "SubDL") - (file.hi ? 10 : 0)
      });
    }
  }
  return output;
}

function dedupeAndFormat(items, languages) {
  const seen = new Set();
  return items
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .sort((a, b) => {
      const aPriority = languages.indexOf(language(a.langRaw));
      const bPriority = languages.indexOf(language(b.langRaw));
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.score - a.score || a.lang.localeCompare(b.lang);
    })
    .slice(0, 80)
    .map((item) => ({
      id: item.id,
      url: item.url,
      lang: item.lang,
      releaseName: `${item.source} • ${safeText(item.release)}`
    }));
}

async function handleSubtitles(type, id, extra, languages) {
  const providers = [openSubtitles(type, id, extra, languages), subdl(type, id, extra, languages)];
  const settled = await Promise.allSettled(providers);
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (settled.some((result) => result.status === "rejected")) {
    console.error("provider failed", settled.filter((r) => r.status === "rejected").map((r) => r.reason && r.reason.message));
  }
  return { subtitles: dedupeAndFormat(items, languages) };
}

function configurePage(host) {
  const checkboxes = LANGUAGE_OPTIONS.map((option) => `
    <label class="row">
      <input type="checkbox" name="lang" value="${option.code}" ${option.code === "AR" ? "checked" : ""}>
      <span>${option.label}</span>
    </label>`).join("");

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>إعداد Subtitle Bridge</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f0f14; color:#eee; max-width:480px; margin:40px auto; padding:0 16px; }
  h1 { font-size:20px; }
  .row { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #292933; font-size:16px; }
  input[type=checkbox] { width:20px; height:20px; }
  button { margin-top:20px; width:100%; padding:14px; font-size:16px; border:none; border-radius:8px; background:#7c5cff; color:#fff; cursor:pointer; }
  #result { margin-top:20px; word-break:break-all; display:none; }
  #result a { color:#7c5cff; }
  #manifestUrl { font-size:13px; color:#aaa; background:#1a1a22; padding:10px; border-radius:6px; display:block; margin-top:8px; }
</style>
</head>
<body>
  <h1>اختر لغة (لغات) الترجمة</h1>
  <p>حدد اللغة اللي تبيها، وضغط "توليد رابط التثبيت". الإضافة راح ترجع لك بس اللغات اللي تختارها هنا — بدون أي لبس.</p>
  <form id="form">${checkboxes}
    <button type="submit">توليد رابط التثبيت</button>
  </form>
  <div id="result">
    <p>اضغط الزر عشان تثبت مباشرة بستريميو:</p>
    <a id="installLink" href="#">📥 تثبيت في Stremio</a>
    <span id="manifestUrl"></span>
  </div>
<script>
  const host = ${JSON.stringify(host)};
  document.getElementById("form").addEventListener("submit", function (event) {
    event.preventDefault();
    const langs = Array.from(document.querySelectorAll('input[name="lang"]:checked')).map(el => el.value);
    if (!langs.length) { alert("اختر لغة وحدة على الأقل"); return; }
    const config = btoa(JSON.stringify({ languages: langs })).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    const manifestUrl = "https://" + host + "/" + config + "/manifest.json";
    const installUrl = "stremio://" + host + "/" + config + "/manifest.json";
    document.getElementById("installLink").href = installUrl;
    document.getElementById("manifestUrl").textContent = manifestUrl;
    document.getElementById("result").style.display = "block";
  });
</script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET") return json(response, 405, { error: "GET only" });

  if (requestUrl.pathname === "/configure" || requestUrl.pathname === "/") {
    return html(response, 200, configurePage(request.headers.host || `localhost:${PORT}`));
  }

  // /manifest.json  OR  /:config/manifest.json
  const manifestMatch = requestUrl.pathname.match(/^\/(?:([^/]+)\/)?manifest\.json$/);
  if (manifestMatch) {
    const languages = decodeConfig(manifestMatch[1]) || DEFAULT_LANGUAGES;
    return json(response, 200, baseManifest(languages));
  }

  // /subtitles/movie/tt123.json
  // /subtitles/movie/tt123/videoSize=123&filename=x.mp4.json   <- real Stremio client format
  // /:config/subtitles/movie/tt123[/extra].json
  const subsMatch = requestUrl.pathname.match(/^\/(?:([^/]+)\/)?subtitles\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/);
  if (subsMatch) {
    const languages = decodeConfig(subsMatch[1]) || DEFAULT_LANGUAGES;
    const extra = parseExtra(subsMatch[4], requestUrl.searchParams);
    try {
      return json(response, 200, await handleSubtitles(subsMatch[2], decodeURIComponent(subsMatch[3]), extra, languages));
    } catch (error) {
      console.error("subtitle request failed", error.message);
      return json(response, 200, { subtitles: [] });
    }
  }

  if (requestUrl.pathname === "/health") return json(response, 200, {
    ok: true,
    defaultLanguages: DEFAULT_LANGUAGES,
    providers: { openSubtitles: ENABLE_OPEN_SUBTITLES, subdl: ENABLE_SUBDL }
  });

  response.writeHead(302, { Location: "/configure" });
  response.end();
});

server.listen(PORT, () => console.log(`Subtitle Bridge listening on :${PORT}`));
