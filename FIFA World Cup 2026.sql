-- =========================================================================
-- PROJECT BLUE-LOCK: FULL DATABASE INIT SCRIPT WITH RLS POLICIES
-- Save this file as 'schema.sql' in your project root.
-- Run this entire script in the Supabase SQL Editor.
-- =========================================================================

-- 1. CLEANUP
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
DROP TABLE IF EXISTS public.bets CASCADE;
DROP TABLE IF EXISTS public.matches CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;

-- 2. CREATE TABLES
CREATE TABLE public.users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    tokens_balance INTEGER DEFAULT 1000 NOT NULL
);

CREATE TABLE public.matches (
    fixture_id TEXT PRIMARY KEY,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    winner TEXT CHECK (winner IN ('home', 'away', 'draw', NULL))
);

CREATE TABLE public.bets (
    bet_id SERIAL PRIMARY KEY,
    user_id TEXT REFERENCES public.users(discord_id) ON DELETE CASCADE,
    fixture_id TEXT REFERENCES public.matches(fixture_id) ON DELETE CASCADE,
    team_picked TEXT NOT NULL CHECK (team_picked IN ('home', 'away', 'draw')),
    amount_wagered INTEGER NOT NULL CHECK (amount_wagered >= 0), -- Just ensures no negative bets
    CONSTRAINT unique_user_fixture UNIQUE (user_id, fixture_id)
);

-- 3. AUTOMATED AUTH SYNCHRONIZATION FUNCTION
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (discord_id, username, display_name, avatar_url, tokens_balance)
    VALUES (
        new.id::text,
        coalesce(new.raw_user_meta_data->>'custom_claims'->>'username', new.raw_user_meta_data->>'full_name', 'Player'),
        coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', 'New Competitor'),
        coalesce(new.raw_user_meta_data->>'avatar_url', null),
        1000
    )
    ON CONFLICT (discord_id) DO UPDATE
    SET 
        username = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================================================
-- 4. ROW LEVEL SECURITY (RLS) & POLICIES
-- =========================================================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;

-- USERS POLICIES
-- Anyone can see the leaderboard standings
CREATE POLICY "Allow public read access to profiles" ON public.users 
    FOR SELECT USING (true);

-- Only the server admin or system service role can directly modify balances (handled via backend)
CREATE POLICY "Allow update from authenticated service only" ON public.users 
    FOR UPDATE USING (auth.role() = 'service_role');

-- MATCHES POLICIES
-- Anyone can see upcoming and finished matches
CREATE POLICY "Allow public read access to matches" ON public.matches 
    FOR SELECT USING (true);

-- BETS POLICIES
-- Anyone can see the public betting feed analytics
CREATE POLICY "Allow public read access to bets" ON public.bets 
    FOR SELECT USING (true);

-- Users can only place or modify their own bets (their web user ID must match the bet's user_id)
CREATE POLICY "Users can manage their own wagers" ON public.bets
    FOR ALL USING (auth.uid()::text = user_id);