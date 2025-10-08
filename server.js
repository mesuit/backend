import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import proxyRoutes from "./routes/proxy.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic global rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // max requests per IP per window
});
app.use(limiter);

// API routes
app.use("/api", proxyRoutes);

// Root route (for Render health check)
app.get("/", (req, res) => {
  res.send("🚀 Maka AI Backend is live!");
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    nodeEnv: process.env.NODE_ENV || "production",
    now: Date.now(),
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`✅ Maka AI backend running on port ${PORT}`)
);
