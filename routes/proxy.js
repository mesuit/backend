import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import upload from "../middleware/upload.js";
import fs from "fs";
import FormData from "form-data";

const router = express.Router();

const PROVIDERS = (process.env.PROVIDERS || "").split(",").map(p => p.trim()).filter(Boolean);
const TIMEOUT = Number(process.env.PROVIDER_TIMEOUT || 7000);
const ATTEMPTS = Number(process.env.PROVIDER_ATTEMPTS || 2);
const CACHE_TTL = Number(process.env.CACHE_TTL || 30);

// parse KEY_MAP into an object: prefix -> key
const KEY_MAP = {};
if (process.env.KEY_MAP) {
  process.env.KEY_MAP.split(",").forEach(pair => {
    const [prefix, key] = pair.split("|");
    if (prefix && key) KEY_MAP[prefix.trim()] = key.trim();
  });
}

function findKeyForProvider(url) {
  for (const prefix in KEY_MAP) {
    if (url.startsWith(prefix)) return KEY_MAP[prefix];
  }
  return null;
}

const cache = new NodeCache({ stdTTL: CACHE_TTL });

// Generic provider-caller tries a few common request shapes
async function callProvider(providerUrl, originalReq, { file } = {}) {
  const q = (originalReq.body && originalReq.body.q) || (originalReq.query && originalReq.query.q) || "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      // If provider includes image= and we have a file, send multipart/form-data with field 'image'
      if (file && providerUrl.includes("image=")) {
        const form = new FormData();
        form.append("image", fs.createReadStream(file.path));
        if (q) form.append("q", q);

        const headers = form.getHeaders();
        const key = findKeyForProvider(providerUrl);
        if (key) headers["Authorization"] = `Bearer ${key}`;

        // If the providerUrl had query params (e.g., '?image='), strip them and call base URL
        const base = providerUrl.split("?")[0];
        const res = await axios.post(base, form, { headers, timeout: TIMEOUT });
        return { success: true, data: res.data };
      }

      // If providerUrl looks like it expects q in query string (contains '?something=')
      if (providerUrl.includes("?") && providerUrl.includes("=") && !providerUrl.includes("image=")) {
        const urlToCall = providerUrl.endsWith("=") ? providerUrl + encodeURIComponent(q) : providerUrl.includes("=q") ? providerUrl.replace(/q=[^&]*/, `q=${encodeURIComponent(q)}`) : providerUrl + encodeURIComponent(q);
        const headers = {};
        const key = findKeyForProvider(providerUrl);
        if (key) headers["Authorization"] = `Bearer ${key}`;
        const res = await axios.get(urlToCall, { headers, timeout: TIMEOUT });
        return { success: true, data: res.data };
      }

      // Fallback: POST JSON { q }
      const headers = { "Content-Type": "application/json" };
      const key = findKeyForProvider(providerUrl);
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const res = await axios.post(providerUrl, { q }, { headers, timeout: TIMEOUT });
      return { success: true, data: res.data };
    } catch (err) {
      console.warn(`[Provider attempt ${attempt+1}] ${providerUrl} -> ${err.message}`);
      if (attempt === ATTEMPTS - 1) return { success: false, error: err };
      // small backoff
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return { success: false, error: new Error("Max attempts reached") };
}

// Primary chat endpoint (supports form-data with file or JSON)
router.post("/chat", upload.single("file"), async (req, res) => {
  const q = (req.body && req.body.q) || (req.query && req.query.q) || "";
  if (!q && !req.file) return res.status(400).json({ error: "Missing q (query) or file." });

  const cacheKey = `chat:${q}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ fromCache: true, provider: cached.provider, data: cached.data });

  const customProviders = (req.body && req.body.providers) || (req.query && req.query.providers);
  const providers = customProviders ? customProviders.split(",").map(p => p.trim()).filter(Boolean) : PROVIDERS;

  if (!providers || providers.length === 0) return res.status(500).json({ error: "No providers configured." });

  for (const providerUrl of providers) {
    try {
      const result = await callProvider(providerUrl, req, { file: req.file });
      if (result.success) {
        cache.set(cacheKey, { provider: providerUrl, data: result.data });
        return res.json({ provider: providerUrl, data: result.data });
      }
    } catch (err) {
      console.warn("Error calling provider:", err?.message || err);
    }
  }

  return res.status(502).json({ error: "All providers failed." });
});

// Simple upload endpoint (stores file and returns info)
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  res.json({
    uploaded: true,
    file: {
      originalname: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    }
  });
});

export default router;
