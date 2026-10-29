import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

type Role = 'member' | 'officer';
type ClaimStatus = 'Submitted' | 'Under review' | 'Needs information' | 'Approved' | 'Rejected';
type ClaimType = 'Hospitalisation' | 'Outpatient' | 'Medication' | 'Dental' | 'Optical' | 'Other';
type Profile = { id: string; full_name: string; email: string; phone: string | null; role: Role; theme: 'light' | 'dark' };
type ClaimFile = { id: string; original_name: string; mime_type: string; size_bytes: number };
type Claim = {
  id: string; claim_number: string; member_id: string; member_name: string; member_email: string;
  provider: string; claim_type: ClaimType; amount: number; description: string | null;
  status: ClaimStatus; officer_comment: string | null; created_at: string; files?: ClaimFile[];
};

const API = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:4000';
const CLAIM_TYPES: ClaimType[] = ['Hospitalisation', 'Outpatient', 'Medication', 'Dental', 'Optical', 'Other'];
const STATUSES: ClaimStatus[] = ['Submitted', 'Under review', 'Needs information', 'Approved', 'Rejected'];

async function api<T>(path: string, session: Session, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [page, setPage] = useState<'overview' | 'claims' | 'submit' | 'settings'>('overview');
  const [claims, setClaims] = useState<Claim[]>([]);
  const [selected, setSelected] = useState<Claim | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupName, setSignupName] = useState('');
  const [signupPhone, setSignupPhone] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [profileForm, setProfileForm] = useState({ full_name: '', email: '', phone: '', theme: 'light' as 'light' | 'dark' });
  const [claimForm, setClaimForm] = useState({ provider: '', claim_type: 'Hospitalisation' as ClaimType, amount: '', description: '' });
  const [evidence, setEvidence] = useState<File[]>([]);
  const [reviewStatus, setReviewStatus] = useState<ClaimStatus>('Under review');
  const [reviewComment, setReviewComment] = useState('');

  const loadProfile = useCallback(async (currentSession: Session) => {
    const data = await api<{ profile: Profile }>('/api/profile', currentSession);
    setProfile(data.profile);
    setProfileForm({ full_name: data.profile.full_name || '', email: data.profile.email || '', phone: data.profile.phone || '', theme: data.profile.theme || 'light' });
  }, []);

  const loadClaims = useCallback(async (currentSession: Session) => {
    const data = await api<{ claims: Claim[] }>('/api/claims', currentSession);
    setClaims(data.claims);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) {
        try { await loadProfile(data.session); await loadClaims(data.session); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not load your account.'); }
      }
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) { setProfile(null); setClaims([]); setSelected(null); setPage('overview'); }
      else if (alive) {
        // Defer requests until Supabase has finished its auth-state callback.
        window.setTimeout(() => {
          if (alive) Promise.all([loadProfile(nextSession), loadClaims(nextSession)]).catch((e) => setError(e instanceof Error ? e.message : 'Could not load account data.'));
        }, 0);
      }
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, [loadProfile, loadClaims]);

  useEffect(() => {
    document.documentElement.dataset.theme = profile?.theme || 'light';
  }, [profile?.theme]);

  const filteredClaims = useMemo(() => claims.filter((claim) => {
    const needle = search.trim().toLowerCase();
    const searchMatch = !needle || [claim.claim_number, claim.provider, claim.member_name, claim.member_email, claim.id].some((v) => (v || '').toLowerCase().includes(needle));
    return searchMatch && (typeFilter === 'all' || claim.claim_type === typeFilter) && (statusFilter === 'all' || claim.status === statusFilter);
  }), [claims, search, typeFilter, statusFilter]);

  async function handleAuth(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      if (authMode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { data: { full_name: signupName.trim(), phone: signupPhone.trim() } },
        });
        if (authError) throw authError;
        if (data.session) setNotice('Your member account was created. Loading your dashboard…');
        else setNotice('Registration submitted. Check your email to confirm your account, then sign in.');
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Authentication failed.'); }
    finally { setBusy(false); }
  }

  async function refreshClaims() {
    if (!session) return;
    await loadClaims(session);
    if (selected) {
      const fresh = await api<{ claim: Claim }>(`/api/claims/${selected.id}`, session);
      setSelected(fresh.claim);
    }
  }

  async function submitClaim(event: FormEvent) {
    event.preventDefault(); if (!session) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const form = new FormData();
      form.append('provider', claimForm.provider.trim());
      form.append('claim_type', claimForm.claim_type);
      form.append('amount', claimForm.amount);
      form.append('description', claimForm.description.trim());
      evidence.forEach((file) => form.append('evidence', file));
      const data = await api<{ claim: Claim }>('/api/claims', session, { method: 'POST', body: form });
      setNotice(`Claim ${data.claim.claim_number} submitted successfully.`);
      setClaimForm({ provider: '', claim_type: 'Hospitalisation', amount: '', description: '' }); setEvidence([]); setPage('claims');
      await loadClaims(session);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not submit claim.'); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (!session) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const requestedEmail = profileForm.email.trim().toLowerCase();
      const currentEmail = (session.user.email || '').toLowerCase();
      if (requestedEmail && requestedEmail !== currentEmail) {
        const { error: emailError } = await supabase.auth.updateUser({ email: requestedEmail });
        if (emailError) throw emailError;
      }
      const data = await api<{ profile: Profile }>('/api/profile', session, {
        method: 'PATCH', body: JSON.stringify({ full_name: profileForm.full_name, phone: profileForm.phone, theme: profileForm.theme }),
      });
      setProfile(data.profile);
      setNotice(requestedEmail !== currentEmail ? 'Profile saved. Supabase may send a confirmation email before your new sign-in email takes effect.' : 'Settings saved successfully.');
      await loadProfile(session);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }

  async function reviewClaim(event: FormEvent) {
    event.preventDefault(); if (!session || !selected) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const data = await api<{ claim: Claim }>(`/api/claims/${selected.id}/review`, session, {
        method: 'PATCH', body: JSON.stringify({ status: reviewStatus, officer_comment: reviewComment }),
      });
      setSelected(data.claim); setNotice('Claim review updated.'); await loadClaims(session);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update review.'); }
    finally { setBusy(false); }
  }

  async function openClaim(claim: Claim) {
    if (!session) return;
    setError('');
    try {
      const data = await api<{ claim: Claim }>(`/api/claims/${claim.id}`, session);
      setSelected(data.claim); setReviewStatus(data.claim.status); setReviewComment(data.claim.officer_comment || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open claim.'); }
  }

  async function openEvidence(claimId: string, fileId: string) {
    if (!session) return;
    try {
      const data = await api<{ url: string }>(`/api/claims/${claimId}/files/${fileId}/url`, session);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open evidence file.'); }
  }

  async function signOut() { await supabase.auth.signOut(); }

  if (!authReady) return <div className="loading-screen"><div className="brand-mark">C</div><p>Loading CareClaim…</p></div>;

  if (!session || !profile) return (
    <main className="auth-screen">
      <section className="auth-aside"><div className="brand-lockup"><div className="brand-mark">C</div><span>CareClaim</span></div><div className="auth-message"><p className="eyebrow">HEALTHCARE CLAIMS, SIMPLIFIED</p><h1>Care for your health. We'll help organise your claims.</h1><p>Submit supporting documents, follow claim progress and keep your claim information in one place.</p><div className="auth-points"><span>✓ Secure account access</span><span>✓ Claim status tracking</span><span>✓ Evidence document upload</span></div></div><p className="aside-foot">CareClaim · Demo application</p></section>
      <section className="auth-form-side"><form className="auth-card" onSubmit={handleAuth}><div className="mobile-brand"><div className="brand-mark">C</div><strong>CareClaim</strong></div><p className="eyebrow">WELCOME {authMode === 'login' ? 'BACK' : 'TO CARECLAIM'}</p><h2>{authMode === 'login' ? 'Sign in to your account' : 'Create your member account'}</h2><p className="muted">{authMode === 'login' ? 'Enter your email and password to continue.' : 'New accounts are registered as members.'}</p>
        {authMode === 'signup' && <><label>Full name<input value={signupName} onChange={(e) => setSignupName(e.target.value)} required autoComplete="name" /></label><label>Phone number <span className="optional">(optional)</span><input value={signupPhone} onChange={(e) => setSignupPhone(e.target.value)} autoComplete="tel" /></label></>}
        <label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} /><span className="hint">Use at least 8 characters.</span></label>
        {error && <div className="alert error">{error}</div>}{notice && <div className="alert success">{notice}</div>}<button className="button primary full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create member account'}</button>
        <p className="auth-switch">{authMode === 'login' ? "Don't have an account?" : 'Already have an account?'} <button type="button" className="text-button" onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setError(''); setNotice(''); }}>{authMode === 'login' ? 'Sign up' : 'Sign in'}</button></p><p className="security-note">Claims officer accounts must be created and assigned by an administrator.</p></form></section>
    </main>
  );

  const isOfficer = profile.role === 'officer';
  const approved = claims.filter((c) => c.status === 'Approved').length;
  const pending = claims.filter((c) => ['Submitted', 'Under review'].includes(c.status)).length;
  const money = (amount: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amount);

  return <div className="app-shell"><aside className="sidebar"><div className="brand-lockup"><div className="brand-mark">C</div><span>CareClaim</span></div><div className="workspace-label">WORKSPACE</div><nav>
    <button className={`nav-item ${page === 'overview' ? 'active' : ''}`} onClick={() => { setPage('overview'); setSelected(null); }}><span>⌂</span> Overview</button>
    <button className={`nav-item ${page === 'claims' ? 'active' : ''}`} onClick={() => { setPage('claims'); setSelected(null); }}><span>▤</span> {isOfficer ? 'All claims' : 'My claims'}</button>
    {!isOfficer && <button className={`nav-item ${page === 'submit' ? 'active' : ''}`} onClick={() => { setPage('submit'); setSelected(null); }}><span>＋</span> Submit a claim</button>}
    <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => { setPage('settings'); setSelected(null); }}><span>⚙</span> Settings</button>
  </nav><div className="sidebar-bottom"><div className="sidebar-user"><div className="avatar">{(profile.full_name || profile.email).slice(0, 1).toUpperCase()}</div><div className="user-copy"><strong>{profile.full_name || 'CareClaim user'}</strong><span>{isOfficer ? 'Claims officer' : 'Member'}</span></div></div><button className="nav-item logout" onClick={signOut}><span>↪</span> Sign out</button></div></aside>
  <main className="main-content"><header className="topbar"><div><span className="breadcrumb">CareClaim</span><span className="breadcrumb-divider">/</span><strong>{selected ? selected.claim_number : page === 'overview' ? 'Overview' : page === 'claims' ? (isOfficer ? 'All claims' : 'My claims') : page === 'submit' ? 'Submit a claim' : 'Settings'}</strong></div><div className="topbar-user"><span className="online-dot" />{isOfficer ? 'Officer workspace' : 'Member portal'}<div className="avatar small">{(profile.full_name || profile.email).slice(0, 1).toUpperCase()}</div></div></header>
    <div className="page-content">{error && <div className="alert error page-alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}{notice && <div className="alert success page-alert">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}
    {selected ? <section className="detail-view"><button className="back-button" onClick={() => setSelected(null)}>← Back to claims</button><div className="page-heading"><div><p className="eyebrow">CLAIM DETAILS</p><h1>{selected.claim_number}</h1><p className="muted">Submitted {new Date(selected.created_at).toLocaleDateString()}</p></div><StatusBadge status={selected.status} /></div><div className="detail-grid"><section className="panel"><div className="panel-heading"><div><h3>Claim information</h3><p>Submitted claim details and supporting evidence.</p></div></div><div className="detail-list"><Detail label="Member" value={selected.member_name} /><Detail label="Member email" value={selected.member_email} /><Detail label="Healthcare provider" value={selected.provider} /><Detail label="Claim type" value={selected.claim_type} /><Detail label="Claim amount" value={money(selected.amount)} /><Detail label="Description" value={selected.description || 'No description provided'} /></div><div className="panel-subheading">Supporting evidence</div>{selected.files?.length ? <div className="file-list">{selected.files.map((file) => <div className="file-row" key={file.id}><span className="file-icon">▧</span><div className="file-info"><strong>{file.original_name}</strong><span>{(file.size_bytes / 1024).toFixed(0)} KB · {file.mime_type}</span></div><button className="button secondary small-button" onClick={() => openEvidence(selected.id, file.id)}>Open file</button></div>)}</div> : <p className="muted">No evidence files attached.</p>}</section><section className="panel"><div className="panel-heading"><div><h3>Review information</h3><p>Latest decision or officer feedback.</p></div></div><div className="review-summary"><span className="field-label">Current status</span><StatusBadge status={selected.status} /><span className="field-label">Officer comment</span><p>{selected.officer_comment || 'No officer comment yet.'}</p></div>{isOfficer && <form className="form-stack review-form" onSubmit={reviewClaim}><div className="panel-subheading">Update review</div><label>Claim status<select value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value as ClaimStatus)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label><label>Comment for member<textarea rows={4} value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} placeholder="Explain the decision or request additional information…" /></label><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save review'}</button></form>}</section></div></section>
    : page === 'overview' ? <><div className="welcome-row"><div><p className="eyebrow">{isOfficer ? 'CLAIMS OPERATIONS' : 'YOUR HEALTHCARE COVER'}</p><h1>{isOfficer ? 'Claims overview' : `Welcome${profile.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`}</h1><p className="muted">{isOfficer ? 'Review submissions and keep claim decisions moving.' : 'Track your submissions and manage your healthcare claims.'}</p></div>{!isOfficer && <button className="button primary" onClick={() => setPage('submit')}>＋ Submit a claim</button>}</div><div className="stats-grid"><Stat label={isOfficer ? 'Total claims' : 'My claims'} value={claims.length} icon="▤" /><Stat label="Awaiting review" value={pending} icon="◷" /><Stat label="Approved" value={approved} icon="✓" /><Stat label="Needs information" value={claims.filter((c) => c.status === 'Needs information').length} icon="!" /></div><section className="panel"><div className="panel-heading"><div><h3>{isOfficer ? 'Recent claims' : 'Your recent claims'}</h3><p>{isOfficer ? 'Latest submissions across members.' : 'A quick look at your latest submissions.'}</p></div><button className="text-button" onClick={() => setPage('claims')}>View all claims →</button></div><ClaimsTable claims={[...claims].slice(0, 5)} officer={isOfficer} onOpen={openClaim} money={money} /></section><div className="info-banner"><div className="info-symbol">i</div><div><strong>Keep your claim documents ready</strong><p>Receipts and supporting documents help the claims team review your submission. Upload clear PDF, JPG, PNG or WEBP files.</p></div></div></>
    : page === 'claims' ? <><div className="page-heading"><div><p className="eyebrow">CLAIM MANAGEMENT</p><h1>{isOfficer ? 'All claims' : 'My claims'}</h1><p className="muted">{isOfficer ? 'Search claims by ID, provider, member name or email.' : 'Search and filter your healthcare claim submissions.'}</p></div>{!isOfficer && <button className="button primary" onClick={() => setPage('submit')}>＋ Submit a claim</button>}</div><section className="panel"><div className="filters"><div className="search-box"><span>⌕</span><input aria-label="Search claims" placeholder={isOfficer ? 'Search claim ID, member, email or provider…' : 'Search by claim ID or provider…'} value={search} onChange={(e) => setSearch(e.target.value)} /><button className="clear-search" onClick={() => setSearch('')} hidden={!search} aria-label="Clear search">×</button></div><select aria-label="Filter by claim type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="all">All claim types</option>{CLAIM_TYPES.map((t) => <option key={t}>{t}</option>)}</select><select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select><button className="button secondary" onClick={() => { setSearch(''); setTypeFilter('all'); setStatusFilter('all'); }}>Reset</button></div><div className="results-count">Showing {filteredClaims.length} of {claims.length} claims</div><ClaimsTable claims={filteredClaims} officer={isOfficer} onOpen={openClaim} money={money} /></section></>
    : page === 'submit' ? <><div className="page-heading"><div><p className="eyebrow">NEW SUBMISSION</p><h1>Submit a claim</h1><p className="muted">Enter the claim details and attach receipts or supporting evidence.</p></div></div><form className="panel form-panel" onSubmit={submitClaim}><div className="panel-heading"><div><h3>Claim details</h3><p>Complete all required fields marked with an asterisk.</p></div></div><div className="form-grid"><label>Healthcare provider *<input required maxLength={160} value={claimForm.provider} onChange={(e) => setClaimForm({ ...claimForm, provider: e.target.value })} placeholder="e.g. City Medical Centre" /></label><label>Claim type *<select value={claimForm.claim_type} onChange={(e) => setClaimForm({ ...claimForm, claim_type: e.target.value as ClaimType })}>{CLAIM_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label><label>Claim amount (MYR) *<div className="amount-input"><span>RM</span><input type="number" required min="0.01" max="1000000" step="0.01" value={claimForm.amount} onChange={(e) => setClaimForm({ ...claimForm, amount: e.target.value })} placeholder="0.00" /></div></label><label className="full-width">Description / reason for claim<textarea rows={4} maxLength={3000} value={claimForm.description} onChange={(e) => setClaimForm({ ...claimForm, description: e.target.value })} placeholder="Briefly describe the treatment or expense…" /></label><div className="full-width"><label>Receipts and evidence <span className="optional">(optional, up to 5 files)</span><div className="upload-zone"><input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" multiple onChange={(e) => { const files = Array.from(e.target.files || []); setEvidence(files.slice(0, 5)); e.currentTarget.value = ''; }} /><span className="upload-symbol">↑</span><strong>Choose files from your device</strong><span>PDF, JPG, PNG or WEBP · Maximum 10 MB per file</span></div></label>{evidence.length > 0 && <div className="selected-files">{evidence.map((file, index) => <div className="file-row" key={`${file.name}-${index}`}><span className="file-icon">▧</span><div className="file-info"><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(0)} KB</span></div><button type="button" className="icon-button" onClick={() => setEvidence(evidence.filter((_, i) => i !== index))} aria-label={`Remove ${file.name}`}>×</button></div>)}</div>}</div></div><div className="form-footer"><p className="muted">Only upload documents related to this claim. Avoid uploading unrelated personal information.</p><button className="button primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit claim →'}</button></div></form></>
    : <><div className="page-heading"><div><p className="eyebrow">ACCOUNT PREFERENCES</p><h1>Settings</h1><p className="muted">Manage your profile and how CareClaim looks.</p></div></div><div className="settings-grid"><form className="panel form-panel" onSubmit={saveProfile}><div className="panel-heading"><div><h3>Personal information</h3><p>Keep your contact details up to date.</p></div></div><div className="form-stack"><label>Full name *<input required maxLength={120} value={profileForm.full_name} onChange={(e) => setProfileForm({ ...profileForm, full_name: e.target.value })} /></label><label>Email address *<input type="email" required value={profileForm.email} onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })} /><span className="hint">Changing your sign-in email may require confirmation through Supabase Auth.</span></label><label>Phone number<input type="tel" maxLength={30} value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} placeholder="e.g. +60 12-345 6789" /></label><div className="readonly-field"><span>Account type</span><strong>{isOfficer ? 'Claims officer' : 'Member'}</strong><small>Only an administrator can assign officer access.</small></div><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div></form><section className="panel form-panel"><div className="panel-heading"><div><h3>Appearance</h3><p>Choose the theme you prefer.</p></div></div><div className="theme-options"><button type="button" className={`theme-option ${profileForm.theme === 'light' ? 'chosen' : ''}`} onClick={() => setProfileForm({ ...profileForm, theme: 'light' })}><span className="theme-preview light-preview"><span /></span><span><strong>Light mode</strong><small>Bright and clear</small></span>{profileForm.theme === 'light' && <span className="theme-check">✓</span>}</button><button type="button" className={`theme-option ${profileForm.theme === 'dark' ? 'chosen' : ''}`} onClick={() => setProfileForm({ ...profileForm, theme: 'dark' })}><span className="theme-preview dark-preview"><span /></span><span><strong>Dark mode</strong><small>Comfortable in low light</small></span>{profileForm.theme === 'dark' && <span className="theme-check">✓</span>}</button></div><p className="hint theme-hint">Save your settings to keep this theme on your account. The preview updates after saving.</p></section></div></>}
    <footer className="page-footer">CareClaim <span>·</span> Healthcare claims made simpler <span>·</span> Demo environment</footer></div></main></div>;
}

function StatusBadge({ status }: { status: ClaimStatus }) { const cls = status.toLowerCase().replaceAll(' ', '-'); return <span className={`status-badge status-${cls}`}><span />{status}</span>; }
function Stat({ label, value, icon }: { label: string; value: number; icon: string }) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value}</strong></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>; }
function ClaimsTable({ claims, officer, onOpen, money }: { claims: Claim[]; officer: boolean; onOpen: (claim: Claim) => void; money: (amount: number) => string }) {
  if (!claims.length) return <div className="empty-state"><span>⌕</span><strong>No claims found</strong><p>Try changing your search or filters.</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>Claim ID</th>{officer && <th>Member</th>}<th>Provider</th><th>Type</th><th>Amount</th><th>Status</th><th>Submitted</th><th /></tr></thead><tbody>{claims.map((claim) => <tr key={claim.id}><td><button className="claim-link" onClick={() => onOpen(claim)}>{claim.claim_number}</button></td>{officer && <td><div className="member-cell"><strong>{claim.member_name}</strong><span>{claim.member_email}</span></div></td>}<td>{claim.provider}</td><td>{claim.claim_type}</td><td className="amount-cell">{money(claim.amount)}</td><td><StatusBadge status={claim.status} /></td><td>{new Date(claim.created_at).toLocaleDateString()}</td><td><button className="row-action" onClick={() => onOpen(claim)} aria-label={`Open ${claim.claim_number}`}>→</button></td></tr>)}</tbody></table></div>;
}
