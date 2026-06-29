-- This will insert the bet. If they already had a bet for this match, it updates it.
INSERT INTO public.bets (user_id, fixture_id, team_picked, amount_wagered)
VALUES ('USER_DISCORD_ID', 'FIXTURE_ID', 'home', 150) -- Options: 'home', 'away', or 'draw'
ON CONFLICT (user_id, fixture_id) 
DO UPDATE SET 
    team_picked = EXCLUDED.team_picked, 
    amount_wagered = EXCLUDED.amount_wagered;