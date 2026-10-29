import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const expected = process.env.INTERNAL_API_KEY;

if (!expected) {
    throw new Error("Missing INTERNAL_API_KEY. Please check backend/.env.");
}

const expectedBuffer = Buffer.from(expected);

// Rejects any request that does not carry the shared secret the middleware sends.
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
    const provided = req.header("x-internal-api-key") ?? "";
    const providedBuffer = Buffer.from(provided);

    const valid =
        providedBuffer.length === expectedBuffer.length &&
        timingSafeEqual(providedBuffer, expectedBuffer);

    if (!valid) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    next();
}
