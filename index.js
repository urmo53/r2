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

const artworkCache = new Map();
let r2ImageCache = { value: null, fetchedAt: 0 };

// iga sample: { ts: unix_ms, value: number }
let samples = [];

// ---------- Helpers ----------

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
    const parsed = parseTrack(title);
    artist = parsed.artist || "Raadio 2";
    title = parsed.song || title;
  }

  return { artist, title };
}

function isExactNews(artist, title) {
  return artist?.trim() === "Uudised" || title?.trim() === "Uudised";
}

// ---------- Listeners ----------

async function fetchListeners() {
  const res = await axios.get(VIEWERS_URL, {
    timeout: 8000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/plain,application/json,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  const value = Number.parseInt(String(res.data).trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

function addSample(value) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  samples.push({ ts: now, value });
  samples = samples.filter((s) => s.ts >= hourAgo);

  if (samples.length > 1000) {
    samples = samples.slice(-1000);
  }
}

function buildHistory(currentValue) {
  const now = Date.now();
  const step = 5 * 60 * 1000; // 5 min
  const result = [];

  for (let i = 11; i >= 0; i--) {
    const targetTime = now - i * step;

    let found = null;
    for (let j = samples.length - 1; j >= 0; j--) {
      if (samples[j].ts <= targetTime) {
        found = samples[j].value;
        break;
      }
    }

    if (found === null) {
      found = samples[0]?.value ?? currentValue;
    }

    result.push(found);
  }

  result[result.length - 1] = currentValue;
  return result;
}

function getTrendForLastMinute(currentValue) {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  let reference = null;

  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].ts <= oneMinuteAgo) {
      reference = samples[i].value;
      break;
    }
  }

  if (reference === null) {
    reference = samples[0]?.value ?? currentValue;
  }

  if (currentValue > reference) return "up";
  if (currentValue < reference) return "down";
  return "flat";
}

// ---------- Artwork ----------

async function getITunes(track) {
  const key = `itunes:${track}`;
  if (artworkCache.has(key)) {
    return artworkCache.get(key);
  }

  try {
    const { artist, song } = parseTrack(track);
    const term = `${artist} ${song}`.trim();
    if (!term || !artist || !song) {
      artworkCache.set(key, null);
      return null;
    }

    const res = await axios.get(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        term
      )}&media=music&entity=song&limit=3`,
      { timeout: 8000 }
    );

    const art =
      res.data?.results?.[0]?.artworkUrl100?.replace("100x100", "600x600") ||
      null;

    artworkCache.set(key, art);
    return art;
  } catch {
    artworkCache.set(key, null);
    return null;
  }
}

async function getDeezer(track) {
  const key = `deezer:${track}`;
  if (artworkCache.has(key)) {
    return artworkCache.get(key);
  }

  try {
    const { artist, song } = parseTrack(track);
    const term = `${artist} ${song}`.trim();
    if (!term || !artist || !song) {
      artworkCache.set(key, null);
      return null;
    }

    const res = await axios.get(
      `https://api.deezer.com/search?q=${encodeURIComponent(term)}`,
      { timeout: 8000 }
    );

    const art =
      res.data?.data?.[0]?.album?.cover_xl ||
      res.data?.data?.[0]?.album?.cover_big ||
      res.data?.data?.[0]?.album?.cover_medium ||
      null;

    artworkCache.set(key, art);
    return art;
  } catch {
    artworkCache.set(key, null);
    return null;
  }
}

async function getR2WebsiteImage() {
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
      $(".radio-player-img").attr("ng-src") ||
      null;

    if (!img) return null;
    if (/favicon/i.test(img)) return null;

    if (img.startsWith("//")) img = "https:" + img;
    if (img.startsWith("/")) img = "https://r2.err.ee" + img;

    r2ImageCache = {
      value: img,
      fetchedAt: now,
    };

    return img;
  } catch (e) {
    console.log("R2 image error:", e.message);
    return null;
  }
}

async function getArtwork(rawTitle, currentStation) {
  const normalizedTitle = cleanTitle(rawTitle);
  const meta = getTrackMeta(normalizedTitle);

  if (isExactNews(meta.artist, meta.title)) {
    return currentStation.fallbackImage;
  }

  if (currentStation.name === "R2") {
    if (!hasTrackSeparator(normalizedTitle)) {
      const r2img = await getR2WebsiteImage();
      if (r2img) return r2img;
      return currentStation.fallbackImage;
    }

    let img = await getITunes(normalizedTitle);
    if (img) return img;

    img = await getDeezer(normalizedTitle);
    if (img) return img;

    img = await getR2WebsiteImage();
    if (img) return img;

    return currentStation.fallbackImage;
  }

  let img = await getITunes(normalizedTitle);
  if (img) return img;

  img = await getDeezer(normalizedTitle);
  if (img) return img;

  return currentStation.fallbackImage;
}

// ---------- Track source ----------

async function fetchStationData() {
  const [ice, listeners] = await Promise.all([
    axios.get(ICECAST_URL, { timeout: 8000 }),
    fetchListeners(),
  ]);

  addSample(listeners);

  const sources = Array.isArray(ice.data?.icestats?.source)
    ? ice.data.icestats.source
    : [ice.data?.icestats?.source].filter(Boolean);

  const fileName = station.stream.split("/").pop().toLowerCase();

  const src =
    sources.find((x) =>
      (x.listenurl || "").toLowerCase().includes(fileName)
    ) ||
    sources.find((x) =>
      (x.listenurl || "").toLowerCase().includes("raadio2.mp3")
    ) ||
    sources.find((x) =>
      String(x.server_name || "").toLowerCase().includes("raadio 2")
    ) ||
    sources.find((x) =>
      String(x.server_description || "").toLowerCase().includes("raadio 2")
    );

  const rawTitle =
    src?.title && String(src.title).trim()
      ? String(src.title).trim()
      : "Hetkel mitte saadaval";

  const artwork = await getArtwork(rawTitle, station);
  const meta = getTrackMeta(rawTitle);

  return {
    name: station.name,
    stream: station.stream,
    artist: meta.artist,
    title: meta.title,
    artwork,
    listeners,
    listenersHistory: buildHistory(listeners),
    listenersTrend1m: getTrendForLastMinute(listeners),
  };
}

// ---------- API ----------

app.get("/api/station", async (_req, res) => {
  try {
    const data = await fetchStationData();

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
    });

    res.json(data);
  } catch (err) {
    console.log("API error:", err.message);

    const lastKnown = samples[samples.length - 1]?.value || 0;
    const fallbackHistory =
      samples.length > 0
        ? buildHistory(lastKnown)
        : Array(12).fill(0);

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
    });

    res.status(200).json({
      error: "Viga",
      name: station.name,
      stream: station.stream,
      artist: "Raadio 2",
      title: "Hetkel eetris....",
      artwork: station.fallbackImage,
      listeners: lastKnown,
      listenersHistory: fallbackHistory,
      listenersTrend1m: "flat",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server töötab: http://localhost:" + PORT);
});