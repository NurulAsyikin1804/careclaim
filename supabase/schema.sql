-- Run this entire script in Supabase Dashboard > SQL Editor > New query.
-- Public sign-up always creates a member. Never accept a role from sign-up metadata.

create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('member', 'officer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.claim_status as enum ('Submitted', 'Under review', 'Needs information', 'Approved', 'Rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.claim_type as enum ('Hospitalisation', 'Outpatient', 'Medication', 'Dental', 'Optical', 'Other');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  phone text,
  role public.user_role not null default 'member',
  theme text not null default 'light' check (theme in ('light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  claim_number text unique not null default ('CC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  member_id uuid not null references public.profiles(id) on delete restrict,
  member_name text not null,
  member_email text not null,
  provider text not null,
  claim_type public.claim_type not null,
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  description text,
  status public.claim_status not null default 'Submitted',
  officer_comment text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.claim_files (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default now()
);

create index if not exists claims_member_id_created_at_idx on public.claims(member_id, created_at desc);
create index if not exists claims_status_idx on public.claims(status);
create index if not exists claim_files_claim_id_idx on public.claim_files(claim_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email, phone, role, theme)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data ->> 'phone', ''), ''),
    'member',
    'light'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.sync_auth_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, ''), updated_at = now() where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
after update of email on auth.users
for each row execute procedure public.sync_auth_email();

alter table public.profiles enable row level security;
alter table public.claims enable row level security;
alter table public.claim_files enable row level security;

-- Browser users can read/update their own basic profile, but cannot change role.
drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
-- Profile edits are handled by the middleware; no browser UPDATE policy is granted.

-- Claims and evidence are accessed through the authenticated Express API using the service role.
-- These policies deliberately do not grant direct browser table access.
drop policy if exists "Members read own claims" on public.claims;
create policy "Members read own claims" on public.claims for select to authenticated using (member_id = (select auth.uid()));
drop policy if exists "Members read own claim file metadata" on public.claim_files;
create policy "Members read own claim file metadata" on public.claim_files for select to authenticated using (member_id = (select auth.uid()));

-- Create a private evidence bucket. Uploads/downloads are proxied by the middleware.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-evidence', 'claim-evidence', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

-- Do not add the service-role key to the frontend. Only the middleware may use it.
