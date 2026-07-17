import { Router } from "express";
import { pool } from "../db/pool.js";
import { redis } from "../db/redis.js";

export const healthRouter = Router();

healthRouter.get("/health", async (req, res) => {
  const status = { server: "ok", postgres: "unknown", redis: "unknown" };

  try {
    await pool.query("SELECT 1");
    status.postgres = "ok";
  } catch (err) {
    status.postgres = "error";
  }

  try {
    await redis.ping();
    status.redis = "ok";
  } catch (err) {
    status.redis = "error";
  }

  const allOk = status.postgres === "ok" && status.redis === "ok";
  res.status(allOk ? 200 : 503).json(status);
});
