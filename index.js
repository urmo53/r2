const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const station = {
  name: "R2",
  stream: "https://icecast.err.ee/raadio2.mp3",
  fallbackImage: "/images/r2.png",
};

const VIEWERS_URL =
  "https://otse.err.ee/api/currentViewers/getChannelViewers?channel=raadio2";
const ICECAST_URL = "https://icecast.err.ee/status-json.xsl";

// ===== STATE =====

let samples = []; // {ts, value}
let r2ImageCache = { value: null, fetchedAt: 0 };
const artworkCache = new Map();

// ===== HELPERS =====

function cleanTitle(raw) {
  return String(raw || "")
    .replace(/–|—/g, "-")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTrackSeparator(title) {
  return cleanTitle(title).includes(" - ");
}

function parseTrack(title) {
  const cleaned = cleanTitle(title);
  const parts = cleaned.split(" - ");
  return {
    artist: parts[0] || "",
    song: parts.slice(1).join(" ") || "",
  };
}

function getTrackMeta(rawTitle) {
  let title = cleanTitle(rawTitle) || "R2";
  let artist = "Raadio 2";

  if (hasTrackSeparator(title)) {
    const p = parseTrack(title);
    artist = p.artist || "Raadio 2";
    title = p.song || title;
  }

  return { artist, title };
}

// ===== LISTENERS =====

async function fetchListeners() {
  const res = await axios.get(VIEWERS_URL, {
    timeout: 8000,
    headers: {
      "Cache-Control": "no-cache",
      "User-Agent": "Mozilla/5.0",
    },
  });

  const val = parseInt(String(res.data).trim(), 10);
  return Number.isFinite(val) ? val : 0;
}

function addSample(value) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  samples.push({ ts: now, value });
  samples = samples.filter((s) => s.ts >= hourAgo);
}

function buildHistory(current) {
  const now = Date.now();
  const step = 5 * 60 * 1000;

  const result = [];

  for (let i = 11; i >= 0; i--) {
    const t = now - i * step;

    let found = null;
    for (let j = samples.length - 1; j >= 0; j--) {
      if (samples[j].ts <= t) {
        found = samples[j].value;
        break;
      }
    }

    if (found === null) {
      found = samples[0]?.value ?? current;
    }

    result.push(found);
  }

  result[result.length - 1] = current;
  return result;
}

// ===== ARTWORK =====

async function getITunes(track) {
  const key = "itunes:" + track;
  if (artworkCache.has(key)) return artworkCache.get(key);

  try {
    const { artist, song } = parseTrack(track);
    if (!artist || !song) return null;

    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      artist + " " + song
    )}&media=music&entity=song&limit=1`;

    const res = await axios.get(url, { timeout: 8000 });

    const art =
      res.data?.results?.[0]?.artworkUrl100?.replace("100x100", "600x600") ||
      null;

    artworkCache.set(key, art);
    return art;
  } catch {
    return null;
  }
}

async function getDeezer(track) {
  const key = "deezer:" + track;
  if (artworkCache.has(key)) return artworkCache.get(key);

  try {
    const { artist, song } = parseTrack(track);
    if (!artist || !song) return null;

    const res = await axios.get(
      `https://api.deezer.com/search?q=${encodeURIComponent(
        artist + " " + song
      )}`,
      { timeout: 8000 }
    );

    const art =
      res.data?.data?.[0]?.album?.cover_xl ||
      res.data?.data?.[0]?.album?.cover_big ||
      null;

    artworkCache.set(key, art);
    return art;
  } catch {
    return null;
  }
}

async function getR2Image() {
  const now = Date.now();

  if (r2ImageCache.value && now - r2ImageCache.fetchedAt < 30000) {
    return r2ImageCache.value;
  }

  try {
    const res = await axios.get("https://r2.err.ee", {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(res.data);

    let img =
      $(".radio-player-img").attr("src") ||
      $(".radio-player-img").attr("ng-src");

    if (!img) return null;

    if (img.startsWith("//")) img = "https:" + img;
    if (img.startsWith("/")) img = "https://r2.err.ee" + img;

    r2ImageCache = { value: img, fetchedAt: now };

    return img;
  } catch {
    return null;
  }
}

async function getArtwork(title) {
  const clean = cleanTitle(title);

  if (clean === "Uudised") {
    return station.fallbackImage;
  }

  if (!hasTrackSeparator(clean)) {
    const r2 = await getR2Image();
    return r2 || station.fallbackImage;
  }

  let art = await getITunes(clean);
  if (art) return art;

  art = await getDeezer(clean);
  if (art) return art;

  art = await getR2Image();
  if (art) return art;

  return station.fallbackImage;
}

// ===== API =====

app.get("/api/station", async (req, res) => {
  try {
    const [ice, listeners] = await Promise.all([
      axios.get(ICECAST_URL, { timeout: 8000 }),
      fetchListeners(),
    ]);

    addSample(listeners);

    const sources = Array.isArray(ice.data?.icestats?.source)
      ? ice.data.icestats.source
      : [ice.data?.icestats?.source].filter(Boolean);

    const src =
      sources.find((x) =>
        (x.listenurl || "").includes("raadio2.mp3")
      ) || sources[0];

    const rawTitle = src?.title || "R2";

    const artwork = await getArtwork(rawTitle);
    const meta = getTrackMeta(rawTitle);

    res.set({
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
    });

    res.json({
      name: station.name,
      stream: station.stream,
      artist: meta.artist,
      title: meta.title,
      artwork,
      listeners,
      listenersHistory: buildHistory(listeners),
    });
  } catch (e) {
    console.log("API error:", e.message);

    res.json({
      name: station.name,
      stream: station.stream,
      artist: "Raadio 2",
      title: "—",
      artwork: station.fallbackImage,
      listeners: 0,
      listenersHistory: Array(12).fill(0),
    });
  }
});

app.listen(PORT, () => {
  console.log("Server töötab: http://localhost:" + PORT);
});