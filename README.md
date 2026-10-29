# CareClaim — Supabase starter implementation

This starter adds Supabase email/password authentication, member registration, profile settings, light/dark mode, claim search/filtering, private evidence uploads, and an officer review workflow to the existing React + TypeScript + Vite + Express stack.

## Important scope and safety notes

- Public registration always creates a `member`. Never add a public role selector.
- An administrator must create an officer user and promote that user's `profiles.role` to `officer`.
- The Express middleware verifies Supabase access tokens and checks the role for protected operations.
- Evidence is stored in a **private** Supabase Storage bucket. The API returns a signed URL that expires after 60 seconds.
- Do not put the Supabase `service_role` key in frontend code or commit it to Git.
- This is a starter/demo, not a production-ready healthcare platform. Before real patient/insurance data, add security review, audit logging, rate limits, malware scanning, data-retention controls, monitoring, and your organisation's privacy/compliance approval.
- AI extraction/risk scoring is not implemented here; connect your team's approved AI API separately.

## 1. Set up Supabase

1. Create a Supabase project in your organisation-approved workspace.
2. Open **SQL Editor → New query**.
3. Paste and run `supabase/schema.sql` from this folder.
4. Open **Project Settings → API** (or API Keys) and copy the project URL and the publishable/anon key.
5. Copy the **service_role** key for the backend only. Treat it as a password.
6. Open **Authentication → URL Configuration** and set the local Site URL to `http://localhost:5173`. Add your local and approved deployed frontend URLs to Redirect URLs.
7. For a quick local demo, you can temporarily disable email confirmation under **Authentication → Providers → Email**. For shared or deployed use, keep confirmation enabled and configure SMTP as required by your organisation.

The SQL script creates `profiles`, `claims`, `claim_files`, signup/email-sync triggers, RLS policies and a private `claim-evidence` bucket. The backend uses the service-role key only after verifying the user's access token.

## 2. Update the frontend

Copy these starter files into your existing project, replacing the corresponding files:

- `frontend/src/App.tsx` → `<project>/frontend/src/App.tsx`
- `frontend/src/styles.css` → `<project>/frontend/src/styles.css`
- `frontend/src/main.tsx` → `<project>/frontend/src/main.tsx`
- `frontend/src/lib/supabase.ts` → `<project>/frontend/src/lib/supabase.ts`

Do not create `index.css`; the app imports `styles.css`.

From the existing `frontend` folder, install the one new dependency:

```powershell
npm install @supabase/supabase-js
```

Create `frontend/.env` based on `frontend/.env.example`:

```env
VITE_API_URL=http://localhost:4000
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY
```

Only the public/anon key belongs in the frontend. Never add `SUPABASE_SERVICE_ROLE_KEY` to `frontend/.env`.

## 3. Update the middleware

Copy these files into the existing `middleware` folder, replacing the corresponding files:

- `middleware/src/index.ts`
- `middleware/package.json`
- `middleware/tsconfig.json`

Install dependencies from the `middleware` folder:

```powershell
npm install
```

Create `middleware/.env` from `middleware/.env.example`:

```env
PORT=4000
FRONTEND_ORIGIN=http://localhost:5173
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=claim-evidence
```

Make sure the frontend and middleware use the same Supabase project. Do not commit either `.env` file.

## 4. Start the app locally

Open two terminals in VS Code.

Terminal 1 — middleware:

```powershell
cd path\to\healthcare-insurance-ai\middleware
npm run dev
```

You should see `CareClaim middleware listening on port 4000`.

Terminal 2 — frontend:

```powershell
cd path\to\healthcare-insurance-ai\frontend
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

Check the middleware health endpoint at `http://localhost:4000/health`; it should return JSON with status `ok`.

If your company laptop blocks package installation, use your approved GitHub Codespace or ask your IT team for the approved package registry/certificate setup. Do not disable TLS certificate verification to work around corporate certificate errors.

## 5. Test member sign-up and claims

1. Select **Sign up** on the login screen.
2. Register with a test email and a password of at least 8 characters.
3. If email confirmation is enabled, confirm the email before signing in.
4. Submit a test claim with a provider, type, amount and a dummy receipt file (PDF/JPG/PNG/WEBP; up to 5 files, 10 MB each).
5. Open **My claims**, search by claim ID/provider, and test the type/status filters.
6. Open **Settings**, update name/phone, choose light/dark mode, then save.
7. Sign out and sign back in to check that the profile and claims remain saved.

Use dummy data and non-sensitive test documents only during development.

## 6. Create a claims officer account

1. In Supabase Dashboard, open **Authentication → Users → Add user** and create a test officer account with an email/password. If the user is not confirmed automatically, confirm it through the dashboard or email flow.
2. The signup trigger normally creates a `profiles` row with role `member` for new Auth users. Promote only the intended officer in **SQL Editor**, replacing the email:

```sql
update public.profiles
set role = 'officer', updated_at = now()
where id = (
  select id from auth.users where lower(email) = lower('officer@example.com')
);
```

3. Confirm exactly one profile row changed and verify the role:

```sql
select id, email, role from public.profiles
where lower(email) = lower('officer@example.com');
```

4. Sign in using that officer account. The officer should see all claims, search by claim ID/member name/member email/provider, and update claim status and comments.

Never allow users to promote themselves from the frontend. Keep officer creation restricted to the project administrator.

## 7. How evidence files work

- Supported types: PDF, JPEG, PNG and WEBP.
- Maximum 5 files per claim, 10 MB per file.
- Files are stored under a user/claim-specific path in a private bucket.
- The app requests a short-lived signed URL from the middleware when an authorised user opens a file.
- The browser never receives the service-role key.

The current implementation checks file MIME type and size, but MIME values can be spoofed. For production, add server-side file signature inspection and malware scanning.

## 8. Cloud Run / CI-CD notes

For Cloud Run, set the middleware environment variables in the service configuration or Secret Manager. Store `SUPABASE_SERVICE_ROLE_KEY` in Secret Manager, not in source control or a Docker image. Set `FRONTEND_ORIGIN` to the deployed frontend origin and `VITE_API_URL` to the deployed middleware URL at frontend build time. Configure Supabase Auth redirect URLs for the deployed frontend. The middleware listens on `process.env.PORT` for Cloud Run.

Deploy the frontend and middleware as appropriate for your team's architecture. Do not deploy until the correct NTT DATA repository, permissions, secrets, and security review have been confirmed.

## Troubleshooting

- **`Missing SUPABASE_URL...`**: confirm `middleware/.env` exists and has real values, then restart the middleware.
- **Profile is not ready**: verify the `schema.sql` trigger ran and a `profiles` row exists for the Auth user.
- **401 invalid session**: sign out/in again and verify both apps use the same Supabase project and anon key.
- **403 claims officer only**: confirm `profiles.role = 'officer'` for the officer user; sign out/in again.
- **Upload errors**: check the private `claim-evidence` bucket exists, the file type is allowed, and each file is under 10 MB.
- **Email change**: Supabase may require confirmation of the new address. The profile email is synchronised when Supabase Auth changes the verified email.
