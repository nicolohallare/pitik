-- Scheduled jobs. The cron secret lives in Vault; the notify function checks it with check_cron_secret().
-- Replace __PROJECT_REF__ with the Supabase project ref before applying (the setup script does this).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(encode(gen_random_bytes(24), 'hex'), 'pitik_cron_secret', 'Shared secret for scheduled calls to the notify function')
where not exists (select 1 from vault.secrets where name = 'pitik_cron_secret');

-- Every 15 minutes: send the one consolidated message per ride (email + Strava line)
select cron.schedule('pitik-notify', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://__PROJECT_REF__.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pitik_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$job$);

-- Hourly: wipe ride tracks kept for late uploads (only pass moments are kept)
select cron.schedule('pitik-purge-tracks', '17 * * * *', $job$ select public.purge_tracks(); $job$);
