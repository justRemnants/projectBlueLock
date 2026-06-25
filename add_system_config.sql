-- Run this in your Supabase SQL Editor to add the system_config table
-- needed for the Master Panel auto-refresh feature.

CREATE TABLE IF NOT EXISTS public.system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Allow the bot (service role) to read and write config
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to config" ON public.system_config
    FOR ALL USING (auth.role() = 'service_role');
