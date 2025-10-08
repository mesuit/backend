import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import upload from "../middleware/upload.js";
import fs from "fs";
import FormData from "form-data";

const router = express.Router();

const PROVIDERS = (process.env.PROVIDERS || "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);

const TIMEOUT = Number(process.env.PROVIDER_TIMEOUT || 7000);
const ATTEMPTS = Number(process.env.PROVIDER_ATTEMPTS || 2);
const CACHE_TTL = Number(process.env.CACHE_TTL || 30);

// parse KEY_MAP into object: prefix -> key
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

// --- Helper: extract actual answer from provider response ---
function extractAnswer(data) {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (data.result) return data.result;
  if (data.answer) return data.answer;
  if (data.output) return data.output;
  if (data.choices?.[0]?.text) return data.choices[0].text;
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  return JSON.stringify(data); // fallback
}

// --- Generic provider caller ---
async function callProvider(providerUrl, originalReq, { file } = {}) {
  const q =
    (originalReq.body && originalReq.body.q) ||
    (originalReq.query && originalReq.query.q) ||
    "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      // Handle image upload
      if (file && providerUrl.includes("image=")) {
        const form = new FormData();
        form.append("image", fs.createReadStream(file.path));
        if (q) form.append("q", q);

        const headers = form.getHeaders();
        const key = findKeyForProvider(providerUrl);
        if (key) headers["Authorization"] = `Bearer ${key}`;

        const base = providerUrl.split("?")[0];
        const res = await axios.post(base, form, { headers, timeout: TIMEOUT });
        return { success: true, data: res.data };
      }

      // GET with query
      if (providerUrl.includes("?") && providerUrl.includes("=") && !providerUrl.includes("image=")) {
        const urlToCall = providerUrl.endsWith("=")
          ? providerUrl + encodeURIComponent(q)
          : providerUrl.includes("=q")
          ? providerUrl.replace(/q=[^&]*/, `q=${encodeURIComponent(q)}`)
          : providerUrl + encodeURIComponent(q);

        const headers = {};
        const key = findKeyForProvider(providerUrl);
        if (key) headers["Authorization"] = `Bearer ${key}`;
        const res = await axios.get(urlToCall, { headers, timeout: TIMEOUT });
        return { success: true, data: res.data };
      }

      // POST JSON fallback
      const headers = { "Content-Type": "application/json" };
      const key = findKeyForProvider(providerUrl);
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const res = await axios.post(providerUrl, { q }, { headers, timeout: TIMEOUT });
      return { success: true, data: res.data };
    } catch (err) {
      console.warn(`[Provider attempt ${attempt + 1}] ${providerUrl} -> ${err.message}`);
      if (attempt === ATTEMPTS - 1) return { success: false, error: err };
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return { success: false, error: new Error("Max attempts reached") };
}

// --- Chat endpoint ---
router.post("/chat", upload.single("file"), async (req, res) => {
  const q =
    (req.body && req.body.q) || (req.query && req.query.q) || "";
  if (!q && !req.file)
    return res.status(400).send("Missing q (query) or file.");

  const cacheKey = `chat:${q}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.send(cached);

  const customProviders =
    (req.body && req.body.providers) ||
    (req.query && req.query.providers);
  const providers = customProviders
    ? customProviders.split(",").map(p => p.trim()).filter(Boolean)
    : PROVIDERS;

  if (!providers || providers.length === 0)
    return res.status(500).send("No providers configured.");

  for (const providerUrl of providers) {
    try {
      const result = await callProvider(providerUrl, req, { file: req.file });
      if (result.success) {
        const answer = extractAnswer(result.data);
        if (!answer) continue;

        cache.set(cacheKey, answer);
        return res.send(answer); // 🔥 send only the answer string
      }
    } catch (err) {
      console.warn("Error calling provider:", err?.message || err);
    }
  }

  return res.status(502).send("All providers failed.");
});

export default router;
