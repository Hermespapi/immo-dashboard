-- Immo Dashboard: Supabase/Postgres Schema + RLS + privater Storage-Bucket
-- Ausführen in Supabase Dashboard → SQL Editor → New query → Run.

create extension if not exists pgcrypto;

create table if not exists public.mieter (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  objekt text not null,
  einheit text,
  miete numeric not null default 0,
  faellig int not null check (faellig between 1 and 28),
  iban text,
  vwz text,
  vertrag_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.zahlungen (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mieter_id uuid not null references public.mieter(id) on delete cascade,
  monat text not null check (monat ~ '^\d{4}-\d{2}$'),
  bezahlt numeric not null default 0,
  datum date,
  notiz text,
  beleg_path text,
  created_at timestamptz not null default now(),
  unique (mieter_id, monat)
);

create index if not exists idx_mieter_user_id on public.mieter(user_id);
create index if not exists idx_zahlungen_user_id on public.zahlungen(user_id);
create index if not exists idx_zahlungen_mieter_monat on public.zahlungen(mieter_id, monat);

alter table public.mieter enable row level security;
alter table public.zahlungen enable row level security;

-- Wiederholbares Setup: alte Policies mit gleichem Namen entfernen.
drop policy if exists "mieter_select_own" on public.mieter;
drop policy if exists "mieter_insert_own" on public.mieter;
drop policy if exists "mieter_update_own" on public.mieter;
drop policy if exists "mieter_delete_own" on public.mieter;

drop policy if exists "zahlungen_select_own" on public.zahlungen;
drop policy if exists "zahlungen_insert_own" on public.zahlungen;
drop policy if exists "zahlungen_update_own" on public.zahlungen;
drop policy if exists "zahlungen_delete_own" on public.zahlungen;

create policy "mieter_select_own" on public.mieter
  for select using (user_id = auth.uid());
create policy "mieter_insert_own" on public.mieter
  for insert with check (user_id = auth.uid());
create policy "mieter_update_own" on public.mieter
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "mieter_delete_own" on public.mieter
  for delete using (user_id = auth.uid());

create policy "zahlungen_select_own" on public.zahlungen
  for select using (user_id = auth.uid());
create policy "zahlungen_insert_own" on public.zahlungen
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.mieter m
      where m.id = zahlungen.mieter_id and m.user_id = auth.uid()
    )
  );
create policy "zahlungen_update_own" on public.zahlungen
  for update using (user_id = auth.uid()) with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.mieter m
      where m.id = zahlungen.mieter_id and m.user_id = auth.uid()
    )
  );
create policy "zahlungen_delete_own" on public.zahlungen
  for delete using (user_id = auth.uid());

-- Privater Storage-Bucket. Falls der Bucket schon existiert, wird er privat gesetzt.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dokumente',
  'dokumente',
  false,
  5242880,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table storage.objects enable row level security;

drop policy if exists "dokumente_select_own" on storage.objects;
drop policy if exists "dokumente_insert_own" on storage.objects;
drop policy if exists "dokumente_update_own" on storage.objects;
drop policy if exists "dokumente_delete_own" on storage.objects;

-- Dateipfade beginnen immer mit der User-ID: <auth.uid()>/vertraege/... oder <auth.uid()>/belege/...
create policy "dokumente_select_own" on storage.objects
  for select using (
    bucket_id = 'dokumente'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "dokumente_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'dokumente'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "dokumente_update_own" on storage.objects
  for update using (
    bucket_id = 'dokumente'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'dokumente'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "dokumente_delete_own" on storage.objects
  for delete using (
    bucket_id = 'dokumente'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
