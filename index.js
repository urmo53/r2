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

function cleanTitle(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/–|—/g, "-")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTrackSeparator(title) {
  const cleaned = cleanTitle(title);
  return cleaned.includes(" - ");
}

function parseTrack(title) {
  const cleaned = cleanTitle(title);
  const parts = cleaned.split(" - ");
  return {
    artist: parts[0] || "",
    song: parts.slice(1).join(" ") || "",
  };
}

async function getITunes(track) {
  try {
    const { artist, song } = parseTrack(track);
    const term = `${artist} ${song}`.trim();
    if (!term || !artist || !song) return null;

    const res = await axios.get(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        term
      )}&media=music&entity=song&limit=3`,
      { timeout: 8000 }
    );

    return (
      res.data?.results?.[0]?.artworkUrl100?.replace("100x100", "400x400") ||
      null
    );
  } catch {
    return null;
  }
}

async function getDeezer(track) {
  try {
    const { artist, song } = parseTrack(track);
    const term = `${artist} ${song}`.trim();
    if (!term || !artist || !song) return null;

    const res = await axios.get(
      `https://api.deezer.com/search?q=${encodeURIComponent(term)}`,
      { timeout: 8000 }
    );

    return res.data?.data?.[0]?.album?.cover_big || null;
  } catch {
    return null;
  }
}

async function getR2WebsiteImage() {
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
    if (img.startsWith("//")) img = "https:" + img;
    if (img.startsWith("/")) img = "https://r2.err.ee" + img;

    return img;
  } catch (e) {
    console.log("R2 image error:", e.message);
    return null;
  }
}

function getForcedImage(title, currentStation) {
  const t = (title || "").toLowerCase();
  const n = (currentStation?.name || "").toLowerCase().trim();

  if (
    n === "r2" &&
    (t.includes("uudised") || t.includes("päevakaja"))
  ) {
    return "/images/uudised.png";
  }

  return null;
}

async function getArtwork(title, currentStation) {
  const forced = getForcedImage(title, currentStation);
  if (forced) return forced;

  const normalizedTitle = cleanTitle(title);

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

async function fetchListeners() {
  try {
    const res = await axios.get(VIEWERS_URL, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/plain,application/json,*/*",
      },
    });

    const listeners = Number.parseInt(String(res.data).trim(), 10);
    return Number.isFinite(listeners) ? listeners : 0;
  } catch (e) {
    console.log("Listeners error:", e.message);
    return 0;
  }
}

app.get("/api/station", async (_req, res) => {
  try {
    const [ice, listeners] = await Promise.all([
      axios.get("https://icecast.err.ee/status-json.xsl", { timeout: 8000 }),
      fetchListeners(),
    ]);

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

    let artist = "Raadio 2";
    let title = rawTitle;

    if (hasTrackSeparator(rawTitle)) {
      const parsed = parseTrack(rawTitle);
      artist = parsed.artist || "Raadio 2";
      title = parsed.song || rawTitle;
    }

    res.json({
      name: station.name,
      stream: station.stream,
      artist,
      title,
      artwork,
      listeners,
    });
  } catch (err) {
    console.log("API error:", err.message);
    res.status(500).json({
      error: "Viga",
      name: station.name,
      stream: station.stream,
      artist: "Raadio 2",
      title: "Hetkel eetris....",
      artwork: station.fallbackImage,
      listeners: 0,
    });
  }
});

app.listen(PORT, () => {
  console.log("Server töötab: http://localhost:" + PORT);
});