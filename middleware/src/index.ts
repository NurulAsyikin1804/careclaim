import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 4000);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'claim-evidence';
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) throw new Error('Missing SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY in middleware/.env');

const authClient = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

type AuthedRequest = Request & { user?: User; profile?: any };
app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '1mb' }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return callback(new Error('Unsupported file type. Use PDF, JPG, PNG or WEBP.'));
    callback(null, true);
  },
});

function getBearer(req: Request) {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session is invalid or has expired. Please sign in again.' });
    const { data: profile, error: profileError } = await adminClient.from('profiles').select('*').eq('id', data.user.id).single();
    if (profileError || !profile) return res.status(403).json({ error: 'Your profile is not ready. Contact the administrator.' });
    req.user = data.user; req.profile = profile; next();
  } catch (e) { next(e); }
}

function requireOfficer(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.profile?.role !== 'officer') return res.status(403).json({ error: 'This action is available to claims officers only.' });
  next();
}

function cleanClaim(row: any, files: any[] = []) {
  return {
    id: row.id, claim_number: row.claim_number, member_id: row.member_id,
    member_name: row.member_name, member_email: row.member_email, provider: row.provider,
    claim_type: row.claim_type, amount: Number(row.amount), description: row.description,
    status: row.status, officer_comment: row.officer_comment, created_at: row.created_at,
    files: files.map((f) => ({ id: f.id, original_name: f.original_name, mime_type: f.mime_type, size_bytes: f.size_bytes })),
  };
}

async function getFilesForClaims(claimIds: string[]) {
  if (!claimIds.length) return new Map<string, any[]>();
  const { data, error } = await adminClient.from('claim_files').select('id, claim_id, original_name, mime_type, size_bytes').in('claim_id', claimIds);
  if (error) throw error;
  const grouped = new Map<string, any[]>();
  for (const file of data || []) grouped.set(file.claim_id, [...(grouped.get(file.claim_id) || []), file]);
  return grouped;
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'careclaim-middleware' }));

app.get('/api/profile', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { data: profile, error } = await adminClient.from('profiles').select('*').eq('id', req.user!.id).single();
    if (error) throw error;
    res.json({ profile: { ...profile, email: req.user!.email || profile.email } });
  } catch (e) { next(e); }
});

app.patch('/api/profile', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { full_name, phone, theme } = req.body || {};
    if (typeof full_name !== 'string' || !full_name.trim()) return res.status(400).json({ error: 'Full name is required.' });
    if (full_name.length > 120) return res.status(400).json({ error: 'Full name must be 120 characters or fewer.' });
    if (phone != null && (typeof phone !== 'string' || phone.length > 30)) return res.status(400).json({ error: 'Phone number must be 30 characters or fewer.' });
    if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'Theme must be light or dark.' });
    const { data, error } = await adminClient.from('profiles').update({ full_name: full_name.trim(), phone: phone?.trim() || null, theme, updated_at: new Date().toISOString() }).eq('id', req.user!.id).select('*').single();
    if (error) throw error;
    res.json({ profile: { ...data, email: req.user!.email || data.email } });
  } catch (e) { next(e); }
});

app.get('/api/claims', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    let query = adminClient.from('claims').select('*').order('created_at', { ascending: false });
    if (req.profile.role !== 'officer') query = query.eq('member_id', req.user!.id);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const files = await getFilesForClaims(rows.map((r) => r.id));
    res.json({ claims: rows.map((r) => cleanClaim(r, files.get(r.id) || [])) });
  } catch (e) { next(e); }
});

app.get('/api/claims/:id', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { data: row, error } = await adminClient.from('claims').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Claim not found.' });
    if (req.profile.role !== 'officer' && row.member_id !== req.user!.id) return res.status(403).json({ error: 'You cannot view this claim.' });
    const { data: files, error: fileError } = await adminClient.from('claim_files').select('id, original_name, mime_type, size_bytes').eq('claim_id', row.id);
    if (fileError) throw fileError;
    res.json({ claim: cleanClaim(row, files || []) });
  } catch (e) { next(e); }
});

app.post('/api/claims', requireAuth, upload.array('evidence', 5), async (req: AuthedRequest, res, next) => {
  const uploadedPaths: string[] = [];
  try {
    if (req.profile.role !== 'member') return res.status(403).json({ error: 'Only member accounts can submit claims.' });
    const provider = String(req.body.provider || '').trim();
    const claimType = String(req.body.claim_type || '');
    const amount = Number(req.body.amount);
    const description = String(req.body.description || '').trim();
    const validTypes = ['Hospitalisation', 'Outpatient', 'Medication', 'Dental', 'Optical', 'Other'];
    if (!provider || provider.length > 160) return res.status(400).json({ error: 'Enter a provider name (maximum 160 characters).' });
    if (!validTypes.includes(claimType)) return res.status(400).json({ error: 'Choose a valid claim type.' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter a valid claim amount.' });
    if (description.length > 3000) return res.status(400).json({ error: 'Description must be 3,000 characters or fewer.' });
    const { data: row, error } = await adminClient.from('claims').insert({
      member_id: req.user!.id, member_name: req.profile.full_name, member_email: req.user!.email,
      provider, claim_type: claimType, amount, description: description || null, status: 'Submitted',
    }).select('*').single();
    if (error) throw error;
    const files = (req.files || []) as Express.Multer.File[];
    for (const file of files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140) || 'evidence';
      const path = `${req.user!.id}/${row.id}/${randomUUID()}-${safeName}`;
      const { error: uploadError } = await adminClient.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPaths.push(path);
      const { error: insertError } = await adminClient.from('claim_files').insert({ claim_id: row.id, member_id: req.user!.id, storage_path: path, original_name: file.originalname.slice(0, 255), mime_type: file.mimetype, size_bytes: file.size });
      if (insertError) throw insertError;
    }
    const { data: savedFiles, error: savedFileError } = await adminClient.from('claim_files').select('id, original_name, mime_type, size_bytes').eq('claim_id', row.id);
    if (savedFileError) throw savedFileError;
    res.status(201).json({ claim: cleanClaim(row, savedFiles || []) });
  } catch (e) {
    // Remove uploaded objects if any part of the upload workflow fails.
    if (uploadedPaths.length) await adminClient.storage.from(bucket).remove(uploadedPaths).catch(() => undefined);
    next(e);
  }
});

app.patch('/api/claims/:id/review', requireAuth, requireOfficer, async (req: AuthedRequest, res, next) => {
  try {
    const { status, officer_comment } = req.body || {};
    const validStatuses = ['Submitted', 'Under review', 'Needs information', 'Approved', 'Rejected'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Choose a valid claim status.' });
    if (officer_comment != null && (typeof officer_comment !== 'string' || officer_comment.length > 3000)) return res.status(400).json({ error: 'Officer comment must be 3,000 characters or fewer.' });
    const { data: row, error } = await adminClient.from('claims').update({ status, officer_comment: String(officer_comment || '').trim() || null, reviewed_by: req.user!.id, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
    if (error || !row) return res.status(404).json({ error: 'Claim not found.' });
    const { data: files, error: fileError } = await adminClient.from('claim_files').select('id, original_name, mime_type, size_bytes').eq('claim_id', row.id);
    if (fileError) throw fileError;
    res.json({ claim: cleanClaim(row, files || []) });
  } catch (e) { next(e); }
});

app.get('/api/claims/:id/files/:fileId/url', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { data: claim, error: claimError } = await adminClient.from('claims').select('id, member_id').eq('id', req.params.id).single();
    if (claimError || !claim) return res.status(404).json({ error: 'Claim not found.' });
    if (req.profile.role !== 'officer' && claim.member_id !== req.user!.id) return res.status(403).json({ error: 'You cannot access this claim file.' });
    const { data: file, error: fileError } = await adminClient.from('claim_files').select('storage_path').eq('id', req.params.fileId).eq('claim_id', claim.id).single();
    if (fileError || !file) return res.status(404).json({ error: 'Evidence file not found.' });
    const { data, error } = await adminClient.storage.from(bucket).createSignedUrl(file.storage_path, 60);
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (e) { next(e); }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err?.message || err);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.' : err.code === 'LIMIT_FILE_COUNT' ? 'You can attach up to 5 files.' : 'Could not process uploaded files.';
    return res.status(400).json({ error: message });
  }
  const message = typeof err?.message === 'string' ? err.message : 'Unexpected server error.';
  res.status(500).json({ error: message });
});

app.listen(port, () => console.log(`CareClaim middleware listening on port ${port}`));
