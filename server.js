"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 7000);
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || "";
const LANGUAGES = (process.env.SUBTITLE_LANGUAGES || "AR,EN")
  .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
const ENABLE_OPEN_SUBTITLES = process.env.ENABLE_OPEN_SUBTITLES !== "false";
const ENABLE_SUBDL = Boolean(SUBDL_API_KEY) && process.env.ENABLE_SUBDL !== "false";
const HIDE_HI = process.env.HIDE_HI === "true";

const manifest = {
  id: "com.personal.subtitlebridge.arabic",
  version: "1.0.3",
  name: "Subtitle Bridge Arabic",
  description: "ترجمات من مصادر موثوقة — بدون ذكاء اصطناعي",
  resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  behaviorHints: { configurable: false }
};

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(JSON.stringify(data));
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

function allowedLanguage(code) {
  return LANGUAGES.includes(language(code));
}

// Stremio expects ISO 639-2/3 language identifiers in subtitle responses.
// Keep the short codes in configuration, but always return the canonical code.
function stremioLanguage(code) {
  const value = language(code);
  const map = { AR: "ara", EN: "eng", FR: "fra", ES: "spa", PT: "por" };
  return map[value] || String(code || "und").toLowerCase();
}

function safeText(value) {
  return String(value || "").slice(0, 180).replace(/[\r\n]+/g, " ");
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

async function openSubtitles(type, id, query) {
  if (!ENABLE_OPEN_SUBTITLES) return [];
  const upstream = new URL(`https://opensubtitles-v3.strem.io/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  for (const [key, value] of query) upstream.searchParams.set(key, value);
  const data = await fetchJson(upstream);
  return (data.subtitles || [])
    .filter((item) => allowedLanguage(item.lang))
    .map((item, index) => ({
      id: `os-${item.id || index}`,
      url: item.url,
      lang: stremioLanguage(item.lang),
      langRaw: item.lang,
      source: "OpenSubtitles",
      release: item.id || "",
      score: releaseScore(item.id, query.get("filename"), "OpenSubtitles")
    }));
}

async function subdl(type, id, query) {
  if (!ENABLE_SUBDL) return [];
  const video = parseVideoId(id);
  if (!video) return [];
  const upstream = new URL("https://api.subdl.com/api/v1/subtitles");
  upstream.searchParams.set("api_key", SUBDL_API_KEY);
  upstream.searchParams.set("imdb_id", video.imdbId);
  upstream.searchParams.set("type", type === "series" ? "tv" : "movie");
  upstream.searchParams.set("languages", LANGUAGES.join(","));
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
      if (!file.url || !allowedLanguage(file.language) || (HIDE_HI && file.hi)) continue;
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
        score: releaseScore(release, query.get("filename"), "SubDL") - (file.hi ? 10 : 0)
      });
    }
  }
  return output;
}

function dedupeAndFormat(items) {
  const seen = new Set();
  return items
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .sort((a, b) => {
      // أولوية أولى: ترتيب اللغة كما هو محدد في LANGUAGES (مثلاً AR قبل EN)
      const aPriority = LANGUAGES.indexOf(language(a.langRaw));
      const bPriority = LANGUAGES.indexOf(language(b.langRaw));
      if (aPriority !== bPriority) return aPriority - bPriority;
      // أولوية ثانية: جودة تطابق الملف (score)
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

async function handleSubtitles(type, id, query) {
  const providers = [openSubtitles(type, id, query), subdl(type, id, query)];
  const settled = await Promise.allSettled(providers);
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return { subtitles: dedupeAndFormat(items) };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET") return json(response, 405, { error: "GET only" });
  if (requestUrl.pathname === "/manifest.json") return json(response, 200, manifest);
  const match = requestUrl.pathname.match(/^\/subtitles\/(movie|series)\/([^/]+)\.json$/);
  if (match) {
    try {
      return json(response, 200, await handleSubtitles(match[1], decodeURIComponent(match[2]), requestUrl.searchParams));
    } catch (error) {
      console.error("subtitle request failed", error.message);
      return json(response, 200, { subtitles: [] });
    }
  }
  if (requestUrl.pathname === "/health") return json(response, 200, {
    ok: true,
    languages: LANGUAGES,
    providers: { openSubtitles: ENABLE_OPEN_SUBTITLES, subdl: ENABLE_SUBDL }
  });
  response.writeHead(302, { Location: "/manifest.json" });
  response.end();
});

server.listen(PORT, () => console.log(`Subtitle Bridge listening on :${PORT}`));
