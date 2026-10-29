import { Router } from "express";
import {
    CLAIM_STATUSES,
    CLAIM_TYPES,
    createClaim,
    getClaim,
    getClaimFile,
    listClaims,
    reviewClaim
} from "../services/claimServices";

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
    typeof value === "string" && UUID.test(value);

// GET /claims            -> all claims (officer view)
// GET /claims?memberId=  -> one member's claims
router.get("/", async (req, res, next) => {
    try {
        const memberId = req.query.memberId;

        if (memberId !== undefined && !isUuid(memberId)) {
            return res.status(400).json({ error: "memberId must be a valid ID." });
        }

        const claims = await listClaims(memberId);
        return res.json({ total: claims.length, claims });
    } catch (error) {
        next(error);
    }
});

// GET /claims/:id
router.get("/:id", async (req, res, next) => {
    try {
        if (!isUuid(req.params.id)) {
            return res.status(404).json({ error: "Claim not found." });
        }

        const claim = await getClaim(req.params.id);
        if (!claim) return res.status(404).json({ error: "Claim not found." });

        return res.json({ claim });
    } catch (error) {
        next(error);
    }
});

// POST /claims  (JSON; the middleware has already authenticated the member and uploaded files)
router.post("/", async (req, res, next) => {
    try {
        const b = req.body ?? {};
        const files: unknown = b.files ?? [];

        const problems: string[] = [];
        if (b.id !== undefined && !isUuid(b.id)) problems.push("id");
        if (!isUuid(b.member_id)) problems.push("member_id");
        if (typeof b.member_name !== "string") problems.push("member_name");
        if (typeof b.member_email !== "string" || !b.member_email) problems.push("member_email");
        if (typeof b.provider !== "string" || !b.provider.trim() || b.provider.length > 160) problems.push("provider");
        if (!CLAIM_TYPES.includes(b.claim_type)) problems.push("claim_type");
        if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0 || b.amount > 1_000_000) problems.push("amount");
        if (b.description != null && (typeof b.description !== "string" || b.description.length > 3000)) problems.push("description");
        if (
            !Array.isArray(files) ||
            files.length > 5 ||
            !files.every(
                (f) =>
                    f &&
                    typeof f.storage_path === "string" &&
                    typeof f.original_name === "string" &&
                    typeof f.mime_type === "string" &&
                    Number.isInteger(f.size_bytes) &&
                    f.size_bytes > 0 &&
                    f.size_bytes <= 10 * 1024 * 1024
            )
        ) {
            problems.push("files");
        }

        if (problems.length > 0) {
            return res.status(400).json({ error: `Invalid claim data: ${problems.join(", ")}.` });
        }

        const claim = await createClaim({
            id: b.id,
            memberId: b.member_id,
            memberName: b.member_name,
            memberEmail: b.member_email,
            provider: b.provider.trim(),
            claimType: b.claim_type,
            amount: b.amount,
            description: b.description ? String(b.description).trim() || null : null,
            files: files as Array<{ storage_path: string; original_name: string; mime_type: string; size_bytes: number }>
        });

        return res.status(201).json({ message: "Claim received successfully", claim });
    } catch (error) {
        next(error);
    }
});

// PATCH /claims/:id/review
router.patch("/:id/review", async (req, res, next) => {
    try {
        if (!isUuid(req.params.id)) {
            return res.status(404).json({ error: "Claim not found." });
        }

        const { status, officer_comment, reviewed_by } = req.body ?? {};

        if (typeof status !== "string" || !(CLAIM_STATUSES as readonly string[]).includes(status)) {
            return res.status(400).json({ error: "Choose a valid claim status." });
        }
        if (
            officer_comment != null &&
            (typeof officer_comment !== "string" || officer_comment.length > 3000)
        ) {
            return res.status(400).json({ error: "Officer comment must be 3,000 characters or fewer." });
        }
        if (!isUuid(reviewed_by)) {
            return res.status(400).json({ error: "A valid reviewer ID is required." });
        }

        const claim = await reviewClaim(
            req.params.id,
            status,
            typeof officer_comment === "string" && officer_comment.trim() ? officer_comment.trim() : null,
            reviewed_by
        );

        if (!claim) return res.status(404).json({ error: "Claim not found." });

        return res.json({ message: "Claim status updated successfully.", claim });
    } catch (error) {
        next(error);
    }
});

// GET /claims/:id/files/:fileId -> storage path + owner, so the middleware can authorise and sign a URL
router.get("/:id/files/:fileId", async (req, res, next) => {
    try {
        const { id, fileId } = req.params;
        if (!isUuid(id) || !isUuid(fileId)) {
            return res.status(404).json({ error: "Evidence file not found." });
        }

        const file = await getClaimFile(id, fileId);
        if (!file) return res.status(404).json({ error: "Evidence file not found." });

        return res.json({ file });
    } catch (error) {
        next(error);
    }
});

export default router;
