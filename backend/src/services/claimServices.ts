import { supabase } from "../lib/supabase";

export const CLAIM_TYPES = [
    "Hospitalisation",
    "Outpatient",
    "Medication",
    "Dental",
    "Optical",
    "Other"
] as const;

export const CLAIM_STATUSES = [
    "Submitted",
    "Under review",
    "Needs information",
    "Approved",
    "Rejected"
] as const;

// Shape returned to the middleware/frontend (snake_case, same as the UI expects).
export type ClaimFile = {
    id: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
};

export type Claim = {
    id: string;
    claim_number: string;
    member_id: string;
    member_name: string;
    member_email: string;
    provider: string;
    claim_type: string;
    amount: number;
    description: string | null;
    status: string;
    officer_comment: string | null;
    created_at: string;
    files: ClaimFile[];
};

type ClaimRow = Omit<Claim, "files" | "amount"> & { amount: number | string };
type ClaimFileRow = ClaimFile & { claim_id: string };

const FILE_COLUMNS = "id, claim_id, original_name, mime_type, size_bytes";

function toClaim(row: ClaimRow, files: ClaimFileRow[] = []): Claim {
    return {
        id: row.id,
        claim_number: row.claim_number,
        member_id: row.member_id,
        member_name: row.member_name,
        member_email: row.member_email,
        provider: row.provider,
        claim_type: row.claim_type,
        amount: Number(row.amount),
        description: row.description,
        status: row.status,
        officer_comment: row.officer_comment,
        created_at: row.created_at,
        files: files.map((f) => ({
            id: f.id,
            original_name: f.original_name,
            mime_type: f.mime_type,
            size_bytes: f.size_bytes
        }))
    };
}

async function loadFiles(claimIds: string[]): Promise<Map<string, ClaimFileRow[]>> {
    const grouped = new Map<string, ClaimFileRow[]>();
    if (claimIds.length === 0) return grouped;

    const { data, error } = await supabase
        .from("claim_files")
        .select(FILE_COLUMNS)
        .in("claim_id", claimIds);

    if (error) throw new Error(`Failed to retrieve claim files: ${error.message}`);

    for (const file of (data ?? []) as ClaimFileRow[]) {
        grouped.set(file.claim_id, [...(grouped.get(file.claim_id) ?? []), file]);
    }
    return grouped;
}

export async function listClaims(memberId: string | undefined): Promise<Claim[]> {
    let query = supabase
        .from("claims")
        .select("*")
        .order("created_at", { ascending: false });

    if (memberId) query = query.eq("member_id", memberId);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to retrieve claims: ${error.message}`);

    const rows = (data ?? []) as ClaimRow[];
    const files = await loadFiles(rows.map((r) => r.id));
    return rows.map((row) => toClaim(row, files.get(row.id) ?? []));
}

export async function getClaim(id: string): Promise<Claim | undefined> {
    const { data, error } = await supabase
        .from("claims")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(`Failed to retrieve claim: ${error.message}`);
    if (!data) return undefined;

    const row = data as ClaimRow;
    const files = await loadFiles([row.id]);
    return toClaim(row, files.get(row.id) ?? []);
}

export type NewClaimInput = {
    id: string | undefined;
    memberId: string;
    memberName: string;
    memberEmail: string;
    provider: string;
    claimType: string;
    amount: number;
    description: string | null;
    files: Array<{
        storage_path: string;
        original_name: string;
        mime_type: string;
        size_bytes: number;
    }>;
};

export async function createClaim(input: NewClaimInput): Promise<Claim> {
    const record: Record<string, unknown> = {
        member_id: input.memberId,
        member_name: input.memberName,
        member_email: input.memberEmail,
        provider: input.provider,
        claim_type: input.claimType,
        amount: input.amount,
        description: input.description,
        status: "Submitted"
    };
    if (input.id) record.id = input.id;

    const { data, error } = await supabase
        .from("claims")
        .insert(record)
        .select("*")
        .single();

    if (error) throw new Error(`Failed to create claim: ${error.message}`);
    const row = data as ClaimRow;

    if (input.files.length > 0) {
        const { error: fileError } = await supabase.from("claim_files").insert(
            input.files.map((f) => ({
                claim_id: row.id,
                member_id: input.memberId,
                storage_path: f.storage_path,
                original_name: f.original_name,
                mime_type: f.mime_type,
                size_bytes: f.size_bytes
            }))
        );

        if (fileError) {
            // Do not leave a claim without its evidence records.
            await supabase.from("claims").delete().eq("id", row.id);
            throw new Error(`Failed to save claim files: ${fileError.message}`);
        }
    }

    const saved = await getClaim(row.id);
    if (!saved) throw new Error("Claim was created but could not be read back.");
    return saved;
}

export async function reviewClaim(
    id: string,
    status: string,
    officerComment: string | null,
    reviewerId: string
): Promise<Claim | undefined> {
    const { data, error } = await supabase
        .from("claims")
        .update({
            status,
            officer_comment: officerComment,
            reviewed_by: reviewerId,
            updated_at: new Date().toISOString()
        })
        .eq("id", id)
        .select("id")
        .maybeSingle();

    if (error) throw new Error(`Failed to update claim: ${error.message}`);
    if (!data) return undefined;

    return getClaim(id);
}

export async function getClaimFile(
    claimId: string,
    fileId: string
): Promise<{ member_id: string; storage_path: string } | undefined> {
    const { data: claim, error: claimError } = await supabase
        .from("claims")
        .select("member_id")
        .eq("id", claimId)
        .maybeSingle();

    if (claimError) throw new Error(`Failed to retrieve claim: ${claimError.message}`);
    if (!claim) return undefined;

    const { data: file, error: fileError } = await supabase
        .from("claim_files")
        .select("storage_path")
        .eq("id", fileId)
        .eq("claim_id", claimId)
        .maybeSingle();

    if (fileError) throw new Error(`Failed to retrieve file: ${fileError.message}`);
    if (!file) return undefined;

    return {
        member_id: (claim as { member_id: string }).member_id,
        storage_path: (file as { storage_path: string }).storage_path
    };
}
