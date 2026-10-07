-- Storage: watermarked previews are public; originals and payout receipts are private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('previews', 'previews', true, 5242880, array['image/jpeg','image/webp']),
  ('originals', 'originals', false, 26214400, array['image/jpeg']),
  ('receipts', 'receipts', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- previews/<pitikero id>/<shoot id>/<file>
create policy previews_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'previews' and (storage.foldername(name))[1] = auth.uid()::text);
create policy previews_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'previews' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- A rider owns an original once an order containing it is paid (definer: riders cannot read photos rows directly)
create or replace function public.owns_original(p_name text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from photos ph join order_items oi on oi.photo_id = ph.id join orders o on o.id = oi.order_id
                 where ph.original_path = p_name and ph.pitikero_id::text = split_part(p_name, '/', 1)
                   and o.user_id = auth.uid() and o.status = 'paid')
$$;
grant execute on function public.owns_original(text) to authenticated;

-- originals/<pitikero id>/<shoot id>/<file>
create policy originals_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'originals' and (storage.foldername(name))[1] = auth.uid()::text);
-- Originals can be removed only by admins (a buyer's download must never break)
create policy originals_delete_admin on storage.objects for delete to authenticated
  using (bucket_id = 'originals' and public.is_admin());
-- Readable by the pitikero who shot it, by riders who paid for it, and by admins
create policy originals_read on storage.objects for select to authenticated
  using (bucket_id = 'originals' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
    or public.owns_original(name)));

-- receipts/<pitikero id>/<file>: admins upload, the pitikero can see their own
create policy receipts_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_admin());
create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text));
