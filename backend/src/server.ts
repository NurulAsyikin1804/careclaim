import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import claimsRouter from "./routes/claims";
import { requireInternalKey } from "./middleware/internalAuth";
import { supabase } from "./lib/supabase";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.BACKEND_HOST || "127.0.0.1";

app.use(express.json({ limit: "1mb" }));

// Health check (no secrets, safe to leave open)
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "careclaim-backend",
        message: "Healthcare app backend is running!"
    });
});

// Everything below requires the shared secret that only the middleware knows.
app.use(requireInternalKey);

// Connect all claim routes under /claims
app.use("/claims", claimsRouter);

// Database connection test (requires the internal key)
app.get("/db-check", async (_req, res) => {
    const { error } = await supabase.from("claims").select("id").limit(1);

    if (error) {
        console.error("Supabase query failed:", error.message);
        return res.status(500).json({
            connected: false,
            message: "Database query failed."
        });
    }

    return res.json({
        connected: true,
        message: "Supabase query succeeded."
    });
});

// JSON errors instead of Express's default HTML stack trace
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, HOST, () => {
    console.log(`CareClaim backend listening at http://${HOST}:${PORT}`);
});
