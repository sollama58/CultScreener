-- CultScreener Database Initialization Script
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

-- Hash index for exact mint lookups
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens USING hash(mint_address);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);
-- Trigram indexes for fast fuzzy search (requires pg_trgm extension)
CREATE INDEX IF NOT EXISTS idx_tokens_name_trgm ON tokens USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol_trgm ON tokens USING gin(symbol gin_trgm_ops);
-- Conviction ranking
CREATE INDEX IF NOT EXISTS idx_tokens_conviction_1m ON tokens(conviction_1m DESC);

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

CREATE INDEX IF NOT EXISTS idx_token_views_mint ON token_views(token_mint);
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

CREATE INDEX IF NOT EXISTS idx_sentiment_votes_mint ON sentiment_votes(token_mint);

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
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curated_tokens_mint ON curated_tokens(mint_address);

-- =====================================================
-- WATCHLIST TABLE
-- Per-wallet token watchlists
-- =====================================================
CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(44) NOT NULL,
    token_mint VARCHAR(44) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(wallet_address, token_mint)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet_address);
CREATE INDEX IF NOT EXISTS idx_watchlist_mint ON watchlist(token_mint);

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

-- Trigger for tokens updated_at
DROP TRIGGER IF EXISTS update_tokens_updated_at ON tokens;
CREATE TRIGGER update_tokens_updated_at
    BEFORE UPDATE ON tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- End of initialization script
