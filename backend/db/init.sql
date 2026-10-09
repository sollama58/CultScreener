-- HolDEX Database Initialization Script
-- Run this script on a fresh PostgreSQL database

-- Enable useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Trigram for fast fuzzy search

-- =====================================================
-- TOKENS TABLE
-- Caches token metadata from chain for faster lookups
-- =====================================================
CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    symbol VARCHAR(50),
    decimals INTEGER,
    logo_uri TEXT,
    conviction_1m DECIMAL,
    conviction_data JSONB,
    conviction_sample_size INTEGER,
    conviction_computed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Token indexes (search trigram, conviction ranking) are owned by initializeDatabase
-- in src/services/database.js; creating them here under the same names took the
-- names with different definitions. mint_address lookups use its UNIQUE index.

-- =====================================================
-- TOKEN VIEWS TABLE
-- Tracks page views per token
-- =====================================================
CREATE TABLE IF NOT EXISTS token_views (
    id SERIAL PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    view_count INTEGER DEFAULT 0,
    last_viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(token_mint)
);

CREATE INDEX IF NOT EXISTS idx_token_views_count ON token_views(view_count DESC);

-- =====================================================
-- SENTIMENT VOTES TABLE
-- Community bullish/bearish votes (one per wallet per token)
-- =====================================================
CREATE TABLE IF NOT EXISTS sentiment_votes (
    id SERIAL PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    voter_wallet VARCHAR(44) NOT NULL,
    sentiment VARCHAR(10) NOT NULL CHECK (sentiment IN ('bullish', 'bearish')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(token_mint, voter_wallet)
);

-- No separate token_mint index: UNIQUE(token_mint, voter_wallet) serves those lookups, and
-- initializeDatabase drops idx_sentiment_votes_mint, so creating it here rebuilt and dropped
-- it on every deploy.

-- =====================================================
-- SENTIMENT TALLIES TABLE
-- Materialized sentiment counts for performance
-- =====================================================
CREATE TABLE IF NOT EXISTS sentiment_tallies (
    token_mint VARCHAR(44) PRIMARY KEY,
    bullish INTEGER DEFAULT 0,
    bearish INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- CURATED TOKENS TABLE
-- Editorially curated tokens with extra metadata
-- =====================================================
CREATE TABLE IF NOT EXISTS curated_tokens (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    banner_url TEXT,
    socials JSONB DEFAULT '{}',
    dexscreener_updated_at TIMESTAMP WITH TIME ZONE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_emerging_cult BOOLEAN DEFAULT FALSE,
    is_tech_coin BOOLEAN DEFAULT FALSE
);

-- =====================================================
-- WATCHLIST TABLE
-- Per-wallet token watchlists
-- =====================================================
CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(44) NOT NULL,
    token_mint VARCHAR(44) NOT NULL,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(wallet_address, token_mint)
);

-- =====================================================
-- HELIUS CREDITS PER DAY (services/heliusCredits.js)
-- =====================================================
CREATE TABLE IF NOT EXISTS helius_credit_days (
    day DATE PRIMARY KEY,
    credits BIGINT NOT NULL DEFAULT 0,
    calls BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- FUNCTIONS & TRIGGERS
-- =====================================================

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for tokens updated_at. Created only when missing: DROP/CREATE TRIGGER takes
-- ACCESS EXCLUSIVE on tokens, and this script runs on every build (postinstall), while
-- the live service is reading that table.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                   WHERE tgname = 'update_tokens_updated_at' AND tgrelid = 'tokens'::regclass) THEN
        CREATE TRIGGER update_tokens_updated_at
            BEFORE UPDATE ON tokens
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- End of initialization script
