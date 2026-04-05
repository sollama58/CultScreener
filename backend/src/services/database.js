const { Pool } = require('pg');
const crypto = require('crypto');

// Database state
let pool = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

// Auto-approval thresholds based on market cap tiers
// Lower mcap tokens need fewer votes (smaller communities)
const APPROVAL_THRESHOLDS = {
  LOW: { maxMcap: 50000, threshold: 10 },      // < $50k mcap: +10 votes
  MEDIUM: { maxMcap: 100000, threshold: 15 },  // $50k-$100k mcap: +15 votes
  HIGH: { threshold: 25 }                       // > $100k mcap: +25 votes
};
const AUTO_APPROVE_THRESHOLD = 25; // Default/max threshold (kept for backwards compatibility)
const AUTO_REJECT_THRESHOLD = parseInt(process.env.AUTO_REJECT_THRESHOLD) || -10;

// Calculate approval threshold based on market cap
function getApprovalThreshold(marketCap) {
  if (!marketCap || marketCap <= 0) {
    // If market cap unknown, use lowest threshold to not penalize new tokens
    return APPROVAL_THRESHOLDS.LOW.threshold;
  }
  if (marketCap <= APPROVAL_THRESHOLDS.LOW.maxMcap) {
    return APPROVAL_THRESHOLDS.LOW.threshold;
  }
  if (marketCap <= APPROVAL_THRESHOLDS.MEDIUM.maxMcap) {
    return APPROVAL_THRESHOLDS.MEDIUM.threshold;
  }
  return APPROVAL_THRESHOLDS.HIGH.threshold;
}

// Minimum review period before auto-approval (in minutes)
// Subsequent submissions require longer review (1 hour) to prevent spam/abuse
const MIN_REVIEW_MINUTES = parseInt(process.env.MIN_REVIEW_MINUTES) || 60;

// Shorter review period for first submission on a token (allows faster initial content)
const FIRST_SUBMISSION_REVIEW_MINUTES = parseInt(process.env.FIRST_SUBMISSION_REVIEW_MINUTES) || 5;

// Minimum token balance required to vote (as percentage of circulating supply)
// 0.1% = must hold at least 0.1% of supply to participate in voting
const MIN_VOTE_BALANCE_PERCENT = parseFloat(process.env.MIN_VOTE_BALANCE_PERCENT) || 0.1;

// Vote weight tiers based on percentage of circulating supply held
// Range: 0.1% (minimum to vote) to 3%+ (maximum weight)
// Uses smooth scaling within tiers for fair representation
const VOTE_WEIGHT_TIERS = [
  { minPercent: 3.0, weight: 3 },    // >= 3% holdings = 3x vote weight (max)
  { minPercent: 1.5, weight: 2.5 },  // >= 1.5% holdings = 2.5x vote weight
  { minPercent: 0.75, weight: 2 },   // >= 0.75% holdings = 2x vote weight
  { minPercent: 0.3, weight: 1.5 },  // >= 0.3% holdings = 1.5x vote weight
  { minPercent: 0.1, weight: 1 }     // >= 0.1% holdings = 1x vote weight (base/minimum)
];

// Calculate vote weight based on holder percentage
// Returns weight multiplier (1x to 3x) based on holdings
function calculateVoteWeight(percentageHeld) {
  // Must meet minimum threshold to vote
  if (!percentageHeld || percentageHeld < MIN_VOTE_BALANCE_PERCENT) return 0;

  for (const tier of VOTE_WEIGHT_TIERS) {
    if (percentageHeld >= tier.minPercent) {
      return tier.weight;
    }
  }
  return 1; // Base weight for minimum holders
}

// Create connection pool
function createPool() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL not set - database features disabled');
    return null;
  }

  // Scale connection pool based on environment
  // Production: Higher pool for concurrent users
  // Development: Lower pool to avoid exhausting local DB
  const isProduction = process.env.NODE_ENV === 'production';
  const maxConnections = parseInt(process.env.DB_POOL_MAX) || (isProduction ? 60 : 10);

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // SSL in production: default rejectUnauthorized to false for Render's self-signed certs.
    // Set DB_SSL_REJECT_UNAUTHORIZED=true only if you have proper CA certs.
    ssl: isProduction ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } : false,
    max: maxConnections,                    // Maximum connections in pool
    min: parseInt(process.env.DB_POOL_MIN) || (isProduction ? 5 : 2), // Warm pool for faster response under load
    idleTimeoutMillis: 60000,               // Close idle connections after 60s
    connectionTimeoutMillis: 5000,          // Timeout for new connections (fail fast under load)
    statement_timeout: 30000,               // Kill queries running > 30s
    query_timeout: 30000,                   // Same as statement_timeout for safety
    allowExitOnIdle: false                  // Keep pool alive
  });
}

// Initialize pool
pool = createPool();

// Connection error handling
if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
    isConnected = false;
  });

  // Periodically check connection recovery
  setInterval(async () => {
    if (!isConnected && pool) {
      try {
        await pool.query('SELECT 1');
        isConnected = true;
        console.log('[Database] Connection recovered');
      } catch (_) {
        // Still disconnected
      }
    }
  }, 30000);
}

// Initialize database tables with retry logic
async function initializeDatabase() {
  if (!pool) {
    console.warn('No database pool available - skipping initialization');
    return false;
  }

  connectionAttempts++;
  console.log(`Database connection attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}...`);

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        id SERIAL PRIMARY KEY,
        mint_address VARCHAR(44) UNIQUE NOT NULL,
        name VARCHAR(255),
        symbol VARCHAR(50),
        decimals INTEGER,
        logo_uri TEXT,
        pair_created_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Migrations for existing databases
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pair_created_at TIMESTAMP;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price DECIMAL;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS market_cap DECIMAL;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS volume_24h DECIMAL;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_change_24h DECIMAL;

      -- Conviction / Diamond Hands persistence
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_1m DECIMAL;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_data JSONB;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_sample_size INTEGER;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_computed_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_tokens_conviction_1m ON tokens(conviction_1m DESC NULLS LAST) WHERE conviction_1m IS NOT NULL AND conviction_1m > 0;

      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) NOT NULL,
        submission_type VARCHAR(20) NOT NULL,
        content_url TEXT NOT NULL,
        submitter_wallet VARCHAR(44),
        status VARCHAR(20) DEFAULT 'pending',
        category VARCHAR(10),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Add category column for existing databases
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS category VARCHAR(10);

      -- CTO (Community Takeover) flag — set by submitter when replacing existing content
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS is_cto BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        voter_wallet VARCHAR(44) NOT NULL,
        vote_type VARCHAR(10) NOT NULL,
        vote_weight DECIMAL(5,2) DEFAULT 1.0,
        voter_balance DECIMAL(30,10) DEFAULT 0,
        voter_percentage DECIMAL(12,6) DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(submission_id, voter_wallet)
      );

      CREATE TABLE IF NOT EXISTS vote_tallies (
        submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        upvotes INTEGER DEFAULT 0,
        downvotes INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        weighted_score DECIMAL(10,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Add new columns if they don't exist (for existing databases)
      DO $$ BEGIN
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_weight DECIMAL(5,2) DEFAULT 1.0;
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_balance DECIMAL(30,10) DEFAULT 0;
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_percentage DECIMAL(12,6) DEFAULT 0;
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
        ALTER TABLE vote_tallies ADD COLUMN IF NOT EXISTS weighted_score DECIMAL(10,2) DEFAULT 0;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;

      -- Watchlist table for user favorites
      CREATE TABLE IF NOT EXISTS watchlist (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(44) NOT NULL,
        token_mint VARCHAR(44) NOT NULL,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(wallet_address, token_mint)
      );

      -- API keys table for external API access
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_hash VARCHAR(64) UNIQUE NOT NULL,
        key_prefix VARCHAR(8) NOT NULL,
        owner_wallet VARCHAR(44) NOT NULL,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        last_used_at TIMESTAMP,
        request_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(owner_wallet)
      );

      -- Drop full_key column if it exists (security: never store plaintext API keys)
      ALTER TABLE api_keys DROP COLUMN IF EXISTS full_key;

      -- Submission indexes
      CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_mint);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_submissions_wallet ON submissions(submitter_wallet);
      CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_submissions_token_status ON submissions(token_mint, status);

      -- Unique constraint on token_mint + submission_type + normalized content_url (prevents duplicate submissions)
      -- Only applies to non-rejected submissions via partial index
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_content
        ON submissions(token_mint, submission_type, LOWER(TRIM(TRAILING '/' FROM content_url)))
        WHERE status != 'rejected';

      -- Vote indexes (optimized for concurrent load)
      CREATE INDEX IF NOT EXISTS idx_votes_submission ON votes(submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_wallet ON votes(voter_wallet);
      CREATE INDEX IF NOT EXISTS idx_votes_voter_submission ON votes(voter_wallet, submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_submission_type ON votes(submission_id, vote_type);
      CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

      -- Token indexes (optimized for search queries that use LOWER())
      CREATE INDEX IF NOT EXISTS idx_tokens_name_symbol ON tokens(LOWER(name), LOWER(symbol));
      -- Separate GIN trigram indexes for fast LIKE %pattern% searches (if pg_trgm extension is available)
      -- These dramatically speed up wildcard searches
      DO $$ BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX IF NOT EXISTS idx_tokens_name_trgm ON tokens USING gin (LOWER(name) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_tokens_symbol_trgm ON tokens USING gin (LOWER(symbol) gin_trgm_ops);
      EXCEPTION WHEN OTHERS THEN
        -- pg_trgm might not be available on some hosts, fall back to btree indexes
        CREATE INDEX IF NOT EXISTS idx_tokens_name_lower ON tokens(LOWER(name) varchar_pattern_ops);
        CREATE INDEX IF NOT EXISTS idx_tokens_symbol_lower ON tokens(LOWER(symbol) varchar_pattern_ops);
      END $$;

      -- Watchlist indexes
      CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_watchlist_token ON watchlist(token_mint);

      -- Vote tally indexes
      CREATE INDEX IF NOT EXISTS idx_vote_tallies_score ON vote_tallies(weighted_score DESC);
      CREATE INDEX IF NOT EXISTS idx_vote_tallies_updated ON vote_tallies(updated_at DESC);

      -- API key indexes
      CREATE INDEX IF NOT EXISTS idx_api_keys_wallet ON api_keys(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

      -- Admin sessions table for admin panel authentication
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id SERIAL PRIMARY KEY,
        session_token VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token);
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

      -- Device sessions table for mobile device linking
      CREATE TABLE IF NOT EXISTS device_sessions (
        id SERIAL PRIMARY KEY,
        session_token VARCHAR(64) UNIQUE NOT NULL,
        wallet_address VARCHAR(44) NOT NULL,
        activated BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        activated_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_device_sessions_token ON device_sessions(session_token);
      CREATE INDEX IF NOT EXISTS idx_device_sessions_wallet ON device_sessions(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_device_sessions_expires ON device_sessions(expires_at);

      -- Token views table for tracking page views
      CREATE TABLE IF NOT EXISTS token_views (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) UNIQUE NOT NULL,
        view_count INTEGER DEFAULT 0,
        last_viewed_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_token_views_mint ON token_views(token_mint);
      CREATE INDEX IF NOT EXISTS idx_token_views_count ON token_views(view_count DESC);

      -- Announcements table for admin-broadcast site-wide messages
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'info' CHECK (type IN ('info', 'warning', 'success', 'error')),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_announcements_active
        ON announcements (created_at DESC)
        WHERE is_active = TRUE;

      -- Sentiment votes table
      CREATE TABLE IF NOT EXISTS sentiment_votes (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) NOT NULL,
        voter_wallet VARCHAR(44) NOT NULL,
        sentiment VARCHAR(10) NOT NULL CHECK (sentiment IN ('bullish', 'bearish')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(token_mint, voter_wallet)
      );

      CREATE TABLE IF NOT EXISTS sentiment_tallies (
        token_mint VARCHAR(44) PRIMARY KEY,
        bullish INTEGER DEFAULT 0,
        bearish INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentiment_votes_mint ON sentiment_votes(token_mint);

      -- Token calls table (rolling 24h endorsements)
      CREATE TABLE IF NOT EXISTS token_calls (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) NOT NULL,
        caller_wallet VARCHAR(44) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_token_calls_wallet_created ON token_calls(caller_wallet, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_calls_mint_created ON token_calls(token_mint, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_calls_created ON token_calls(created_at DESC);

      -- Market cap at time of call
      ALTER TABLE token_calls ADD COLUMN IF NOT EXISTS mcap_at_call DECIMAL;

      -- One call record per wallet per token (re-calls update timestamp, preserve original mcap)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_calls_wallet_mint
        ON token_calls(caller_wallet, token_mint);

      -- Curated tokens (admin-managed, enriched from DexScreener)
      CREATE TABLE IF NOT EXISTS curated_tokens (
        id SERIAL PRIMARY KEY,
        mint_address VARCHAR(44) UNIQUE NOT NULL,
        banner_url TEXT,
        socials JSONB DEFAULT '{}',
        dexscreener_updated_at TIMESTAMP WITH TIME ZONE,
        added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_curated_tokens_mint ON curated_tokens(mint_address);

      -- Bug reports table
      CREATE TABLE IF NOT EXISTS bug_reports (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        contact_info VARCHAR(255),
        page_url TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'resolved', 'dismissed')),
        admin_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
      CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at DESC);
    `);

    await client.query('COMMIT');
    isConnected = true;
    connectionAttempts = 0;
    console.log('Database initialized successfully');
    return true;

  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
    }
    console.error(`Database connection failed (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}):`, error.message);
    isConnected = false;

    // Retry if we haven't exceeded max attempts
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
      setTimeout(() => initializeDatabase(), RETRY_DELAY_MS);
    } else {
      console.error('Max database connection attempts reached. Database features will be unavailable.');
    }
    return false;

  } finally {
    if (client) {
      client.release();
    }
  }
}

// Token operations
// Placeholder names that should never overwrite real token metadata
const PLACEHOLDER_NAMES = new Set(['unknown token', 'unknown']);

async function upsertToken(token) {
  if (!pool) {
    console.warn('Database not available - skipping token upsert');
    return null;
  }
  const { mintAddress, name, symbol, decimals, logoUri, pairCreatedAt, price, marketCap, volume24h, priceChange24h } = token;

  // Never persist placeholder names — they poison search results
  const isPlaceholder = !name || PLACEHOLDER_NAMES.has(name.toLowerCase());
  const isPlaceholderSymbol = !symbol || symbol === 'UNKNOWN' || symbol === '???';

  // If both name and symbol are placeholders, only update price/market data
  if (isPlaceholder && isPlaceholderSymbol) {
    // Still update price/market data if we have any
    if (price || marketCap || volume24h || priceChange24h != null) {
      const result = await pool.query(
        `UPDATE tokens SET
           price = COALESCE($2, tokens.price),
           market_cap = COALESCE($3, tokens.market_cap),
           volume_24h = COALESCE($4, tokens.volume_24h),
           price_change_24h = COALESCE($5, tokens.price_change_24h),
           updated_at = NOW()
         WHERE mint_address = $1
         RETURNING *`,
        [mintAddress, price || null, marketCap || null, volume24h || null, priceChange24h != null ? priceChange24h : null]
      );
      return result.rows[0] || null;
    }
    return null;
  }

  // Use COALESCE for name/symbol so placeholders never overwrite real data
  const result = await pool.query(
    `INSERT INTO tokens (mint_address, name, symbol, decimals, logo_uri, pair_created_at, price, market_cap, volume_24h, price_change_24h)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (mint_address) DO UPDATE SET
       name = CASE WHEN LOWER(EXCLUDED.name) IN ('unknown token', 'unknown') THEN tokens.name ELSE COALESCE(EXCLUDED.name, tokens.name) END,
       symbol = CASE WHEN EXCLUDED.symbol IN ('UNKNOWN', '???') THEN tokens.symbol ELSE COALESCE(EXCLUDED.symbol, tokens.symbol) END,
       decimals = EXCLUDED.decimals,
       logo_uri = COALESCE(EXCLUDED.logo_uri, tokens.logo_uri),
       pair_created_at = COALESCE(EXCLUDED.pair_created_at, tokens.pair_created_at),
       price = COALESCE(EXCLUDED.price, tokens.price),
       market_cap = COALESCE(EXCLUDED.market_cap, tokens.market_cap),
       volume_24h = COALESCE(EXCLUDED.volume_24h, tokens.volume_24h),
       price_change_24h = COALESCE(EXCLUDED.price_change_24h, tokens.price_change_24h),
       updated_at = NOW()
     RETURNING *`,
    [mintAddress, name, symbol, decimals, logoUri, pairCreatedAt || null, price || null, marketCap || null, volume24h || null, priceChange24h != null ? priceChange24h : null]
  );
  return result.rows[0];
}

async function getToken(mintAddress) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT * FROM tokens WHERE mint_address = $1',
    [mintAddress]
  );
  return result.rows[0];
}

// Batch fetch tokens by mint addresses (efficient for most_viewed)
async function getTokensBatch(mintAddresses) {
  if (!pool || !mintAddresses || mintAddresses.length === 0) return [];

  // Use ANY() for efficient batch lookup
  const result = await pool.query(
    'SELECT * FROM tokens WHERE mint_address = ANY($1)',
    [mintAddresses]
  );
  return result.rows;
}

// Save conviction (diamond hands) data for a token
async function upsertConviction(mintAddress, distribution, sampleSize, analyzed) {
  if (!pool || !mintAddress || !distribution) return null;
  const conviction1m = distribution['1m'] ?? null;
  const result = await pool.query(
    `UPDATE tokens SET
       conviction_1m = $2,
       conviction_data = $3,
       conviction_sample_size = $4,
       conviction_computed_at = NOW()
     WHERE mint_address = $1
     RETURNING mint_address`,
    [mintAddress, conviction1m, JSON.stringify(distribution), analyzed != null ? analyzed : sampleSize]
  );
  // If token doesn't exist in DB yet, insert a minimal row
  if (result.rows.length === 0) {
    await pool.query(
      `INSERT INTO tokens (mint_address, conviction_1m, conviction_data, conviction_sample_size, conviction_computed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (mint_address) DO UPDATE SET
         conviction_1m = EXCLUDED.conviction_1m,
         conviction_data = EXCLUDED.conviction_data,
         conviction_sample_size = EXCLUDED.conviction_sample_size,
         conviction_computed_at = NOW()`,
      [mintAddress, conviction1m, JSON.stringify(distribution), analyzed != null ? analyzed : sampleSize]
    );
  }
}

// Get top tokens by conviction (>1M diamond hands percentage)
async function getTopConvictionTokens(limit = 25, offset = 0, filters = {}) {
  if (!pool) return { tokens: [], total: 0 };

  // Build a unified view: tokens with conviction data UNION curated tokens
  // that may not have conviction data yet. Curated tokens without data appear
  // with conviction_1m = 0 so they're visible while analysis runs.
  const filterConditions = [];
  const params = [];
  let paramIndex = 1;

  if (filters.minConviction != null) {
    filterConditions.push(`conviction_1m >= $${paramIndex}`);
    params.push(filters.minConviction);
    paramIndex++;
  }
  if (filters.minMcap != null) {
    filterConditions.push(`market_cap >= $${paramIndex}`);
    params.push(filters.minMcap);
    paramIndex++;
  }
  if (filters.maxMcap != null) {
    filterConditions.push(`market_cap <= $${paramIndex}`);
    params.push(filters.maxMcap);
    paramIndex++;
  }
  if (filters.minSample != null) {
    filterConditions.push(`conviction_sample_size >= $${paramIndex}`);
    params.push(filters.minSample);
    paramIndex++;
  }
  if (filters.search) {
    filterConditions.push(`(LOWER(name) LIKE $${paramIndex} OR LOWER(symbol) LIKE $${paramIndex})`);
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    params.push(`%${escaped.toLowerCase()}%`);
    paramIndex++;
  }

  // Base CTE: merge tokens-with-conviction and curated tokens into one set.
  // Curated tokens that already have conviction data appear once (from tokens table).
  // Curated tokens WITHOUT conviction data get a row with conviction_1m = 0.
  const baseCte = `
    WITH combined AS (
      SELECT mint_address, name, symbol, logo_uri, price, market_cap, volume_24h, price_change_24h,
             conviction_1m, conviction_data, conviction_sample_size, conviction_computed_at
      FROM tokens
      WHERE conviction_1m IS NOT NULL AND conviction_1m > 0

      UNION ALL

      SELECT c.mint_address, COALESCE(t.name, NULL) AS name, COALESCE(t.symbol, NULL) AS symbol,
             COALESCE(t.logo_uri, NULL) AS logo_uri, t.price, t.market_cap, t.volume_24h, t.price_change_24h,
             COALESCE(t.conviction_1m, 0) AS conviction_1m,
             t.conviction_data, t.conviction_sample_size, t.conviction_computed_at
      FROM curated_tokens c
      LEFT JOIN tokens t ON t.mint_address = c.mint_address
      WHERE t.conviction_1m IS NULL OR t.conviction_1m = 0 OR t.mint_address IS NULL
    )`;

  const outerConditions = filterConditions.length > 0
    ? 'WHERE ' + filterConditions.join(' AND ')
    : '';

  const countResult = await pool.query(
    `${baseCte} SELECT COUNT(*) FROM combined ${outerConditions}`,
    params
  );
  const total = parseInt(countResult.rows[0].count) || 0;

  const result = await pool.query(
    `${baseCte}
     SELECT * FROM combined
     ${outerConditions}
     ORDER BY conviction_1m DESC NULLS LAST
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  return { tokens: result.rows, total };
}

// Search tokens by name, symbol, or mint address
// Max query length to prevent DoS via expensive LIKE queries
const MAX_SEARCH_QUERY_LENGTH = 100;

async function searchTokens(query, limit = 10) {
  if (!pool) return [];

  // Truncate query to prevent DoS attacks with very long search strings
  const safeQuery = query.slice(0, MAX_SEARCH_QUERY_LENGTH);
  // Escape LIKE metacharacters to prevent wildcard injection
  const escapedQuery = safeQuery.replace(/[%_\\]/g, '\\$&');
  const searchPattern = `%${escapedQuery.toLowerCase()}%`;

  const result = await pool.query(
    `SELECT mint_address, name, symbol, decimals, logo_uri, price, market_cap, volume_24h, created_at
     FROM tokens
     WHERE (
       (LOWER(name) LIKE $1 AND LOWER(COALESCE(name, '')) NOT IN ('unknown token', 'unknown', ''))
       OR LOWER(symbol) LIKE $1
       OR mint_address LIKE $2
     )
     ORDER BY
       CASE
         WHEN LOWER(symbol) = $3 THEN 1
         WHEN LOWER(name) = $3 THEN 2
         WHEN LOWER(symbol) LIKE $4 THEN 3
         WHEN LOWER(name) LIKE $4 THEN 4
         ELSE 5
       END,
       created_at DESC
     LIMIT $5`,
    [searchPattern, `%${safeQuery}%`, safeQuery.toLowerCase(), `${safeQuery.toLowerCase()}%`, limit]
  );

  return result.rows.map(row => ({
    address: row.mint_address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    logoURI: row.logo_uri,
    price: row.price ? parseFloat(row.price) : 0,
    marketCap: row.market_cap ? parseFloat(row.market_cap) : null,
    volume24h: row.volume_24h ? parseFloat(row.volume_24h) : null,
    source: 'local'
  }));
}

// Find tokens with similar names or symbols using pg_trgm similarity scoring
// Used for anti-spoofing: helps users identify confusing or copycat token names
async function findSimilarTokens(mintAddress, name, symbol, limit = 5) {
  if (!pool || !name) return [];

  const safeName = (name || '').slice(0, 100).toLowerCase();

  // Search by token name similarity only (not ticker/symbol)
  // Minimum threshold of 0.15 prevents irrelevant noise
  const result = await pool.query(
    `SELECT
       mint_address, name, symbol, decimals, logo_uri, pair_created_at,
       price, market_cap, volume_24h,
       similarity(LOWER(name), $1) AS name_sim
     FROM tokens
     WHERE mint_address != $2
       AND similarity(LOWER(name), $1) > 0.15
     ORDER BY name_sim DESC
     LIMIT $3`,
    [safeName, mintAddress, limit]
  );

  return result.rows.map(row => ({
    address: row.mint_address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    logoURI: row.logo_uri,
    pairCreatedAt: row.pair_created_at || null,
    price: parseFloat(row.price) || null,
    marketCap: parseFloat(row.market_cap) || null,
    volume24h: parseFloat(row.volume_24h) || null,
    similarityScore: parseFloat(row.name_sim.toFixed(3)),
    nameSimilarity: parseFloat(row.name_sim.toFixed(3)),
    symbolSimilarity: null,
    source: 'local'
  }));
}

// Submission operations
// Uses transaction to atomically check for duplicates and create submission
async function createSubmission({ tokenMint, submissionType, contentUrl, submitterWallet, category, isCTO }) {
  if (!pool) throw new Error('Database not available');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert with ON CONFLICT to handle race conditions atomically
    // The unique index idx_submissions_unique_content enforces uniqueness at DB level
    const result = await client.query(
      `INSERT INTO submissions (token_mint, submission_type, content_url, submitter_wallet, category, is_cto)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tokenMint, submissionType, contentUrl, submitterWallet, category || null, !!isCTO]
    );

    // Initialize vote tally
    await client.query(
      `INSERT INTO vote_tallies (submission_id) VALUES ($1)`,
      [result.rows[0].id]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    // Check if it's a unique constraint violation (duplicate submission)
    if (error.code === '23505' && error.constraint?.includes('submissions_unique_content')) {
      const duplicateError = new Error('This content has already been submitted for this token');
      duplicateError.code = 'DUPLICATE_SUBMISSION';
      throw duplicateError;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getSubmission(id) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.id = $1`,
    [id]
  );
  return result.rows[0];
}

async function getSubmissionsByToken(tokenMint, { type, status } = {}) {
  if (!pool) return [];
  let query = `
    SELECT s.*, vt.upvotes, vt.downvotes, vt.score
    FROM submissions s
    LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
    WHERE s.token_mint = $1
  `;
  const params = [tokenMint];

  if (status) {
    params.push(status);
    query += ` AND s.status = $${params.length}`;
  }

  if (type) {
    params.push(type);
    query += ` AND s.submission_type = $${params.length}`;
  }

  query += ' ORDER BY vt.score DESC, s.created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

async function getApprovedSubmissions(tokenMint) {
  return getSubmissionsByToken(tokenMint, { status: 'approved' });
}

// Batch version — single query for multiple mints (eliminates N+1 in public API batch endpoint)
async function getApprovedSubmissionsBatch(tokenMints) {
  if (!pool || !tokenMints || tokenMints.length === 0) return {};
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.token_mint = ANY($1) AND s.status = 'approved'
     ORDER BY vt.score DESC, s.created_at DESC`,
    [tokenMints]
  );
  // Group by token_mint
  const grouped = {};
  for (const mint of tokenMints) grouped[mint] = [];
  for (const row of result.rows) {
    if (!grouped[row.token_mint]) grouped[row.token_mint] = [];
    grouped[row.token_mint].push(row);
  }
  return grouped;
}

// Lightweight batch check: returns Set of mints that have at least one approved submission
async function hasApprovedSubmissionsBatch(tokenMints) {
  if (!pool || !tokenMints || tokenMints.length === 0) return new Set();
  const result = await pool.query(
    `SELECT DISTINCT token_mint FROM submissions WHERE token_mint = ANY($1) AND status = 'approved'`,
    [tokenMints]
  );
  return new Set(result.rows.map(r => r.token_mint));
}

// Vote operations - Optimized with delta-based tally updates for high concurrency
async function createVote({ submissionId, voterWallet, voteType, voterBalance = 0, voterPercentage = 0, marketCap = null }) {
  if (!pool) throw new Error('Database not available');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate vote weight based on holder percentage
    const voteWeight = calculateVoteWeight(voterPercentage);

    // Check if vote already exists to calculate delta
    const existingVote = await client.query(
      `SELECT * FROM votes
       WHERE submission_id = $1 AND voter_wallet = $2`,
      [submissionId, voterWallet]
    );

    const isNewVote = existingVote.rows.length === 0;
    const oldVoteType = existingVote.rows[0]?.vote_type;

    // Skip if vote unchanged
    if (!isNewVote && oldVoteType === voteType) {
      await client.query('COMMIT');
      return existingVote.rows[0];
    }

    // Insert or update the vote (UPSERT handles concurrent inserts safely)
    const result = await client.query(
      `INSERT INTO votes (submission_id, voter_wallet, vote_type, vote_weight, voter_balance, voter_percentage)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id, voter_wallet) DO UPDATE SET
         vote_type = EXCLUDED.vote_type,
         vote_weight = EXCLUDED.vote_weight,
         voter_balance = EXCLUDED.voter_balance,
         voter_percentage = EXCLUDED.voter_percentage,
         updated_at = NOW()
       RETURNING *`,
      [submissionId, voterWallet, voteType, voteWeight, voterBalance, voterPercentage]
    );

    // Full-scan tally recalculation — safe under concurrent writes.
    // The previous delta-based approach was O(1) but vulnerable to double-counting
    // when two transactions for the same (submission, voter) both computed isNewVote=true
    // before either committed. Full-scan is O(n) on votes for this submission but
    // guarantees correctness regardless of interleaving. Typical n < 100.
    await client.query(
      `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
       SELECT
         $1,
         COUNT(*) FILTER (WHERE vote_type = 'up'),
         COUNT(*) FILTER (WHERE vote_type = 'down'),
         COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
         COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
         NOW()
       FROM votes WHERE submission_id = $1
       ON CONFLICT (submission_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         downvotes = EXCLUDED.downvotes,
         score = EXCLUDED.score,
         weighted_score = EXCLUDED.weighted_score,
         updated_at = NOW()`,
      [submissionId]
    );

    await client.query('COMMIT');

    // Post-commit: run auto-moderation check (non-critical -- don't fail the vote if this errors)
    try {
      const tally = await getVoteTally(submissionId);
      const weightedScore = parseFloat(tally?.weighted_score) || 0;
      await checkAutoModeration(submissionId, weightedScore, marketCap);
    } catch (err) {
      console.error(`[Votes] Post-commit auto-moderation failed for submission ${submissionId}:`, err.message);
    }

    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getVote(submissionId, voterWallet) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT * FROM votes WHERE submission_id = $1 AND voter_wallet = $2',
    [submissionId, voterWallet]
  );
  return result.rows[0];
}

async function getVotesBatch(submissionIds, voterWallet) {
  if (!pool) return [];
  if (!submissionIds || submissionIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    'SELECT * FROM votes WHERE submission_id = ANY($1) AND voter_wallet = $2',
    [submissionIds, voterWallet]
  );
  return result.rows;
}

async function updateVote(submissionId, voterWallet, voteType, { marketCap = null, voterBalance = null, voterPercentage = null } = {}) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Recalculate vote weight from current holder percentage
    const voteWeight = voterPercentage != null ? calculateVoteWeight(voterPercentage) : null;
    if (voteWeight != null) {
      await client.query(
        `UPDATE votes SET vote_type = $3, vote_weight = $4, voter_balance = $5, voter_percentage = $6, updated_at = NOW()
         WHERE submission_id = $1 AND voter_wallet = $2`,
        [submissionId, voterWallet, voteType, voteWeight, voterBalance, voterPercentage]
      );
    } else {
      await client.query(
        `UPDATE votes SET vote_type = $3, updated_at = NOW()
         WHERE submission_id = $1 AND voter_wallet = $2`,
        [submissionId, voterWallet, voteType]
      );
    }
    await client.query(
      `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
       SELECT
         $1,
         COUNT(*) FILTER (WHERE vote_type = 'up'),
         COUNT(*) FILTER (WHERE vote_type = 'down'),
         COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
         COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
         NOW()
       FROM votes WHERE submission_id = $1
       ON CONFLICT (submission_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         downvotes = EXCLUDED.downvotes,
         score = EXCLUDED.score,
         weighted_score = EXCLUDED.weighted_score,
         updated_at = NOW()
       RETURNING score, weighted_score`,
      [submissionId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Post-commit: run auto-moderation check (non-critical -- don't fail the vote if this errors)
  try {
    const weightedScore = (await getVoteTally(submissionId))?.weighted_score || 0;
    await checkAutoModeration(submissionId, parseFloat(weightedScore), marketCap);
  } catch (err) {
    console.error(`[Votes] Post-commit auto-moderation failed for submission ${submissionId}:`, err.message);
  }
}

async function deleteVote(submissionId, voterWallet, marketCap = null) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM votes WHERE submission_id = $1 AND voter_wallet = $2',
      [submissionId, voterWallet]
    );
    await client.query(
      `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
       SELECT
         $1,
         COUNT(*) FILTER (WHERE vote_type = 'up'),
         COUNT(*) FILTER (WHERE vote_type = 'down'),
         COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
         COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
         NOW()
       FROM votes WHERE submission_id = $1
       ON CONFLICT (submission_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         downvotes = EXCLUDED.downvotes,
         score = EXCLUDED.score,
         weighted_score = EXCLUDED.weighted_score,
         updated_at = NOW()
       RETURNING score, weighted_score`,
      [submissionId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Post-commit: run auto-moderation check (non-critical -- don't fail the vote if this errors)
  try {
    const weightedScore = (await getVoteTally(submissionId))?.weighted_score || 0;
    await checkAutoModeration(submissionId, parseFloat(weightedScore), marketCap);
  } catch (err) {
    console.error(`[Votes] Post-commit auto-moderation failed for submission ${submissionId}:`, err.message);
  }
}

async function getVoteTally(submissionId) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT * FROM vote_tallies WHERE submission_id = $1',
    [submissionId]
  );
  return result.rows[0];
}

async function updateVoteTally(submissionId, marketCap = null) {
  if (!pool) return;
  // Update vote counts (now includes weighted score)
  const result = await pool.query(
    `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
     SELECT
       $1,
       COUNT(*) FILTER (WHERE vote_type = 'up'),
       COUNT(*) FILTER (WHERE vote_type = 'down'),
       COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
       COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
       NOW()
     FROM votes WHERE submission_id = $1
     ON CONFLICT (submission_id) DO UPDATE SET
       upvotes = EXCLUDED.upvotes,
       downvotes = EXCLUDED.downvotes,
       score = EXCLUDED.score,
       weighted_score = EXCLUDED.weighted_score,
       updated_at = NOW()
     RETURNING score, weighted_score`,
    [submissionId]
  );

  // Auto-approve or auto-reject based on WEIGHTED score
  // Uses market cap from context for tiered thresholds
  const weightedScore = parseFloat(result.rows[0]?.weighted_score) || 0;
  await checkAutoModeration(submissionId, weightedScore, marketCap);
}

// Auto-moderation based on weighted vote score
// Includes minimum review period before auto-approval
// First submission for a token uses shorter review period (5 min vs 1 hour)
// Approval threshold varies by market cap tier
async function checkAutoModeration(submissionId, weightedScore, marketCap = null) {
  // Get dynamic approval threshold based on market cap
  const approvalThreshold = getApprovalThreshold(marketCap);

  // Check if submission meets the threshold for its market cap tier
  if (weightedScore >= approvalThreshold) {
    // Check if minimum review period has passed
    const submission = await pool.query(
      `SELECT created_at, token_mint FROM submissions WHERE id = $1 AND status = 'pending'`,
      [submissionId]
    );

    if (submission.rows.length > 0) {
      const { created_at: createdAt, token_mint: tokenMint } = submission.rows[0];
      const now = new Date();
      const minutesSinceCreation = (now - new Date(createdAt)) / (1000 * 60);

      // Check if this token has any approved submissions already
      const existingApproved = await pool.query(
        `SELECT 1 FROM submissions WHERE token_mint = $1 AND status = 'approved' LIMIT 1`,
        [tokenMint]
      );
      const isFirstSubmission = existingApproved.rows.length === 0;

      // Use shorter review period for first submission on a token
      const requiredMinutes = isFirstSubmission ? FIRST_SUBMISSION_REVIEW_MINUTES : MIN_REVIEW_MINUTES;

      // Only auto-approve if minimum review period has passed
      if (minutesSinceCreation >= requiredMinutes) {
        await pool.query(
          `UPDATE submissions SET status = 'approved' WHERE id = $1 AND status = 'pending'`,
          [submissionId]
        );
      }
      // If threshold is met but review period hasn't passed, submission stays pending
      // It will be approved on the next vote after the period passes
    }
  } else if (weightedScore <= AUTO_REJECT_THRESHOLD) {
    // Auto-rejection doesn't require review period (to quickly remove spam)
    await pool.query(
      `UPDATE submissions SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
      [submissionId]
    );
  }
}

// Update submission status manually
async function updateSubmissionStatus(submissionId, status) {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE submissions SET status = $2 WHERE id = $1 RETURNING *`,
    [submissionId, status]
  );
  return result.rows[0];
}

// Get submissions by wallet
async function getSubmissionsByWallet(wallet) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.submitter_wallet = $1
     ORDER BY s.created_at DESC`,
    [wallet]
  );
  return result.rows;
}

// Get pending submissions (for moderation)
async function getPendingSubmissions(limit = 50) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.status = 'pending'
     ORDER BY s.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ==========================================
// Watchlist operations
// ==========================================

// Atomic watchlist add with limit enforcement (prevents TOCTOU race condition)
async function addToWatchlistAtomic(walletAddress, tokenMint, maxItems = 100) {
  if (!pool) return { limitReached: true };

  // Ensure table exists (handles edge case where schema init hasn't completed)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      wallet_address VARCHAR(44) NOT NULL,
      token_mint VARCHAR(44) NOT NULL,
      added_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(wallet_address, token_mint)
    )
  `).catch(() => {});

  const result = await pool.query(
    `INSERT INTO watchlist (wallet_address, token_mint)
     SELECT $1, $2
     WHERE (SELECT COUNT(*) FROM watchlist WHERE wallet_address = $1) < $3
     ON CONFLICT (wallet_address, token_mint) DO NOTHING
     RETURNING *`,
    [walletAddress, tokenMint, maxItems]
  );
  if (result.rows.length === 0) {
    const exists = await isInWatchlist(walletAddress, tokenMint);
    if (exists) return { wallet_address: walletAddress, token_mint: tokenMint, exists: true };
    return { limitReached: true };
  }
  return result.rows[0];
}

// Add token to user's watchlist
async function addToWatchlist(walletAddress, tokenMint) {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO watchlist (wallet_address, token_mint)
     VALUES ($1, $2)
     ON CONFLICT (wallet_address, token_mint) DO NOTHING
     RETURNING *`,
    [walletAddress, tokenMint]
  );
  return result.rows[0] || { wallet_address: walletAddress, token_mint: tokenMint, exists: true };
}

// Remove token from user's watchlist
async function removeFromWatchlist(walletAddress, tokenMint) {
  if (!pool) return null;
  const result = await pool.query(
    `DELETE FROM watchlist
     WHERE wallet_address = $1 AND token_mint = $2
     RETURNING *`,
    [walletAddress, tokenMint]
  );
  return result.rows[0];
}

// Get user's watchlist
async function getWatchlist(walletAddress) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT w.token_mint, t.name, t.symbol, t.logo_uri
     FROM watchlist w
     LEFT JOIN tokens t ON w.token_mint = t.mint_address
     WHERE w.wallet_address = $1
     ORDER BY w.id DESC`,
    [walletAddress]
  );
  return result.rows.map(row => ({
    mint: row.token_mint,
    name: row.name,
    symbol: row.symbol,
    logoUri: row.logo_uri,
    addedAt: null
  }));
}

// Check if token is in user's watchlist
async function isInWatchlist(walletAddress, tokenMint) {
  if (!pool) return false;
  const result = await pool.query(
    `SELECT 1 FROM watchlist
     WHERE wallet_address = $1 AND token_mint = $2`,
    [walletAddress, tokenMint]
  );
  return result.rows.length > 0;
}

// Check multiple tokens against watchlist (for batch operations)
async function checkWatchlistBatch(walletAddress, tokenMints) {
  if (!pool) return {};
  if (!tokenMints || tokenMints.length === 0) return {};

  const result = await pool.query(
    `SELECT token_mint FROM watchlist
     WHERE wallet_address = $1 AND token_mint = ANY($2)`,
    [walletAddress, tokenMints]
  );

  // Return a map of mint -> true for items in watchlist
  const watchlistMap = {};
  result.rows.forEach(row => {
    watchlistMap[row.token_mint] = true;
  });
  return watchlistMap;
}

// Get watchlist count for a user
async function getWatchlistCount(walletAddress) {
  if (!pool) return 0;
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM watchlist WHERE wallet_address = $1`,
    [walletAddress]
  );
  return parseInt(result.rows[0].count);
}

// ==========================================
// API Key operations
// ==========================================

// Create a new API key for a wallet (one per wallet)
async function createApiKey(ownerWallet, keyHash, keyPrefix, name = null) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO api_keys (owner_wallet, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_wallet) DO NOTHING
     RETURNING id, key_prefix, owner_wallet, name, created_at, is_active`,
    [ownerWallet, keyHash, keyPrefix, name]
  );
  return result.rows[0];
}

// Get API key by hash (for validation)
async function getApiKeyByHash(keyHash) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys WHERE key_hash = $1`,
    [keyHash]
  );
  return result.rows[0];
}

// Get API key info for a wallet
async function getApiKeyByWallet(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys WHERE owner_wallet = $1`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Update last used timestamp and increment request count
async function updateApiKeyUsage(keyHash) {
  if (!pool) return;

  await pool.query(
    `UPDATE api_keys
     SET last_used_at = NOW(), request_count = request_count + 1
     WHERE key_hash = $1`,
    [keyHash]
  );
}

// Revoke/deactivate an API key
async function revokeApiKey(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE owner_wallet = $1 RETURNING *`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Delete an API key (allows user to create a new one)
async function deleteApiKey(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM api_keys WHERE owner_wallet = $1 RETURNING *`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Check if wallet already has an API key
async function hasApiKey(ownerWallet) {
  if (!pool) return false;

  const result = await pool.query(
    `SELECT 1 FROM api_keys WHERE owner_wallet = $1`,
    [ownerWallet]
  );
  return result.rows.length > 0;
}

// ==========================================
// Admin Session operations
// ==========================================

// Create admin session
async function createAdminSession(sessionToken, expiresAt, ipAddress = null, userAgent = null) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO admin_sessions (session_token, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)
     RETURNING id, session_token, created_at, expires_at`,
    [sessionToken, expiresAt, ipAddress, userAgent]
  );
  return result.rows[0];
}

// Get admin session by token
async function getAdminSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM admin_sessions
     WHERE session_token = $1 AND expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0];
}

// Delete admin session (logout)
async function deleteAdminSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM admin_sessions WHERE session_token = $1 RETURNING *`,
    [sessionToken]
  );
  return result.rows[0];
}

// Clean up expired admin sessions
async function cleanupExpiredAdminSessions() {
  if (!pool) return 0;

  const result = await pool.query(
    `DELETE FROM admin_sessions WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

// ==========================================
// Device Session operations (mobile device linking)
// ==========================================

const DEVICE_SESSION_ACTIVATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes to scan QR
const DEVICE_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function createDeviceSession(sessionToken, walletAddress, activationExpiresAt, ipAddress = null, userAgent = null) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO device_sessions (session_token, wallet_address, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, session_token, wallet_address, created_at, expires_at`,
    [sessionToken, walletAddress, activationExpiresAt, ipAddress, userAgent]
  );
  return result.rows[0];
}

async function getDeviceSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM device_sessions
     WHERE session_token = $1 AND expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0];
}

async function activateDeviceSession(sessionToken) {
  if (!pool) return null;

  const newExpiry = new Date(Date.now() + DEVICE_SESSION_DURATION_MS);
  const result = await pool.query(
    `UPDATE device_sessions
     SET activated = TRUE, activated_at = NOW(), expires_at = $2
     WHERE session_token = $1 AND activated = FALSE AND expires_at > NOW()
     RETURNING *`,
    [sessionToken, newExpiry]
  );
  return result.rows[0];
}

async function deleteDeviceSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM device_sessions WHERE session_token = $1 RETURNING *`,
    [sessionToken]
  );
  return result.rows[0];
}

async function deleteDeviceSessionsByWallet(walletAddress) {
  if (!pool) return 0;

  const result = await pool.query(
    `DELETE FROM device_sessions WHERE wallet_address = $1`,
    [walletAddress]
  );
  return result.rowCount;
}

async function getDeviceSessionsByWallet(walletAddress) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT id, created_at, activated, activated_at, expires_at
     FROM device_sessions
     WHERE wallet_address = $1 AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [walletAddress]
  );
  return result.rows;
}

async function cleanupExpiredDeviceSessions() {
  if (!pool) return 0;

  const result = await pool.query(
    `DELETE FROM device_sessions WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

// ==========================================
// Admin Statistics operations
// ==========================================

// Admin stats cache to prevent expensive COUNT(*) queries under load
// TTL: 30 seconds - balances freshness with database load reduction
const ADMIN_STATS_CACHE_TTL_MS = 30000;
let adminStatsCache = {
  data: null,
  cachedAt: 0
};

// Get site statistics for admin dashboard (with caching)
async function getAdminStats() {
  if (!pool) return null;

  // Return cached stats if still fresh
  const now = Date.now();
  if (adminStatsCache.data && (now - adminStatsCache.cachedAt) < ADMIN_STATS_CACHE_TTL_MS) {
    return { ...adminStatsCache.data, cached: true, cacheAge: now - adminStatsCache.cachedAt };
  }

  const stats = {};

  // Helper: count rows from a table, returning 0 if the table doesn't exist
  const safeCount = async (query) => {
    try {
      const r = await pool.query(query);
      return parseInt(r.rows[0].count) || 0;
    } catch { return 0; }
  };

  // Run all counts in parallel — each is independent and handles missing tables
  const [
    pendingSubs, approvedSubs, rejectedSubs, totalSubs,
    totalVotes, totalTokens, totalApiKeys, activeApiKeys,
    watchlistEntries, recentSubs, recentVotes, newBugs
  ] = await Promise.all([
    safeCount("SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'"),
    safeCount("SELECT COUNT(*) as count FROM submissions WHERE status = 'approved'"),
    safeCount("SELECT COUNT(*) as count FROM submissions WHERE status = 'rejected'"),
    safeCount("SELECT COUNT(*) as count FROM submissions"),
    safeCount("SELECT COUNT(*) as count FROM votes"),
    safeCount("SELECT COUNT(*) as count FROM tokens"),
    safeCount("SELECT COUNT(*) as count FROM api_keys"),
    safeCount("SELECT COUNT(*) as count FROM api_keys WHERE is_active = true"),
    safeCount("SELECT COUNT(*) as count FROM watchlist"),
    safeCount("SELECT COUNT(*) as count FROM submissions WHERE created_at > NOW() - INTERVAL '24 hours'"),
    safeCount("SELECT COUNT(*) as count FROM votes WHERE created_at > NOW() - INTERVAL '24 hours'"),
    safeCount("SELECT COUNT(*) as count FROM bug_reports WHERE status = 'new'")
  ]);

  stats.submissions = { pending: pendingSubs, approved: approvedSubs, rejected: rejectedSubs, total: totalSubs };
  stats.votes = totalVotes;
  stats.tokens = totalTokens;
  stats.apiKeys = { total: totalApiKeys, active: activeApiKeys };
  stats.watchlistEntries = watchlistEntries;
  stats.recentSubmissions = recentSubs;
  stats.recentVotes = recentVotes;
  stats.bugReports = newBugs;

  // Update cache
  adminStatsCache = { data: stats, cachedAt: now };
  return { ...stats, cached: false };
}

// Invalidate admin stats cache (call after bulk operations)
function invalidateAdminStatsCache() {
  adminStatsCache = { data: null, cachedAt: 0 };
}

// ============================================================
// Announcement operations
// ============================================================

async function getActiveAnnouncements() {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, title, message, type, created_at, expires_at
     FROM announcements
     WHERE is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC`
  );
  return result.rows;
}

async function getAllAnnouncements() {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, title, message, type, is_active, created_at, expires_at
     FROM announcements
     ORDER BY created_at DESC
     LIMIT 100`
  );
  return result.rows;
}

async function createAnnouncement({ title, message, type = 'info', expiresAt = null }) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(
    `INSERT INTO announcements (title, message, type, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, message, type, is_active, created_at, expires_at`,
    [title, message, type, expiresAt]
  );
  return result.rows[0];
}

async function updateAnnouncement(id, { isActive, title, message, type, expiresAt }) {
  if (!pool) throw new Error('Database not available');
  // Build dynamic SET clause from provided fields only
  const updates = [];
  const params = [];
  let idx = 1;

  if (isActive !== undefined)  { updates.push(`is_active = $${idx++}`);  params.push(isActive); }
  if (title !== undefined)     { updates.push(`title = $${idx++}`);      params.push(title); }
  if (message !== undefined)   { updates.push(`message = $${idx++}`);    params.push(message); }
  if (type !== undefined)      { updates.push(`type = $${idx++}`);       params.push(type); }
  if (expiresAt !== undefined) { updates.push(`expires_at = $${idx++}`); params.push(expiresAt); }

  if (updates.length === 0) throw new Error('No fields to update');

  params.push(id);
  const result = await pool.query(
    `UPDATE announcements SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING id, title, message, type, is_active, created_at, expires_at`,
    params
  );
  return result.rows[0] || null;
}

async function deleteAnnouncement(id) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(
    `DELETE FROM announcements WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.rowCount > 0;
}

// ============================================================
// Bug report operations
// ============================================================

async function createBugReport({ category, description, contactInfo, pageUrl, ipAddress, userAgent }) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(
    `INSERT INTO bug_reports (category, description, contact_info, page_url, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, category, description, contact_info, page_url, status, created_at`,
    [category, description, contactInfo || null, pageUrl || null, ipAddress || null, userAgent || null]
  );
  return result.rows[0];
}

async function getAllBugReports({ status, limit = 50, offset = 0 } = {}) {
  if (!pool) return { reports: [], total: 0 };

  let whereClause = '';
  const params = [];
  let paramIdx = 1;

  if (status && status !== 'all') {
    whereClause = `WHERE status = $${paramIdx++}`;
    params.push(status);
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM bug_reports ${whereClause}`,
    params
  );

  const countParams = [...params];
  countParams.push(Math.min(Math.max(1, parseInt(limit) || 50), 100));
  countParams.push(Math.max(0, parseInt(offset) || 0));

  const result = await pool.query(
    `SELECT id, category, description, contact_info, page_url, status, admin_notes, created_at, updated_at
     FROM bug_reports
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    countParams
  );

  return {
    reports: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

async function getBugReport(id) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT id, category, description, contact_info, page_url, ip_address, user_agent, status, admin_notes, created_at, updated_at
     FROM bug_reports WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function updateBugReportStatus(id, { status, adminNotes }) {
  if (!pool) throw new Error('Database not available');
  const updates = [];
  const params = [];
  let idx = 1;

  if (status !== undefined)     { updates.push(`status = $${idx++}`);      params.push(status); }
  if (adminNotes !== undefined) { updates.push(`admin_notes = $${idx++}`); params.push(adminNotes); }

  if (updates.length === 0) throw new Error('No fields to update');

  updates.push('updated_at = NOW()');
  params.push(id);

  const result = await pool.query(
    `UPDATE bug_reports SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING id, category, description, contact_info, page_url, status, admin_notes, created_at, updated_at`,
    params
  );
  return result.rows[0] || null;
}

async function deleteBugReport(id) {
  if (!pool) throw new Error('Database not available');
  const result = await pool.query(
    `DELETE FROM bug_reports WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.rowCount > 0;
}

async function getBugReportCounts() {
  if (!pool) return { new: 0, acknowledged: 0, resolved: 0, dismissed: 0, total: 0 };
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'new') as new_count,
      COUNT(*) FILTER (WHERE status = 'acknowledged') as acknowledged_count,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
      COUNT(*) FILTER (WHERE status = 'dismissed') as dismissed_count,
      COUNT(*) as total
    FROM bug_reports
  `);
  const row = result.rows[0];
  return {
    new: parseInt(row.new_count),
    acknowledged: parseInt(row.acknowledged_count),
    resolved: parseInt(row.resolved_count),
    dismissed: parseInt(row.dismissed_count),
    total: parseInt(row.total)
  };
}

// Get all submissions with pagination for admin
async function getAllSubmissions({ status, tokenMint, limit = 50, offset = 0, sortBy = 'created_at', sortOrder = 'DESC' } = {}) {
  if (!pool) return { submissions: [], total: 0 };

  // Validate sort column
  const validSortColumns = ['created_at', 'score', 'weighted_score', 'status'];
  const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  let query = `
    SELECT s.*, vt.upvotes, vt.downvotes, vt.score, vt.weighted_score,
           t.name as token_name, t.symbol as token_symbol
    FROM submissions s
    LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
    LEFT JOIN tokens t ON s.token_mint = t.mint_address
  `;
  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`s.status = $${params.length}`);
  }

  if (tokenMint) {
    params.push(tokenMint);
    conditions.push(`s.token_mint = $${params.length}`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  // Handle sorting - use explicit map to prevent interpolation of user input
  const SORT_COLUMN_MAP = {
    'created_at': 's.created_at',
    'score': 'vt.score',
    'weighted_score': 'vt.weighted_score',
    'status': 's.status'
  };
  const sortColumnFull = SORT_COLUMN_MAP[sortColumn] || 's.created_at';
  query += ` ORDER BY ${sortColumnFull} ${order} NULLS LAST`;

  params.push(limit, offset);
  query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await pool.query(query, params);

  // Get total count
  let countQuery = `SELECT COUNT(*) FROM submissions s`;
  const countParams = [];
  const countConditions = [];
  if (status) {
    countParams.push(status);
    countConditions.push(`s.status = $${countParams.length}`);
  }
  if (tokenMint) {
    countParams.push(tokenMint);
    countConditions.push(`s.token_mint = $${countParams.length}`);
  }
  if (countConditions.length > 0) {
    countQuery += ` WHERE ${countConditions.join(' AND ')}`;
  }
  const countResult = await pool.query(countQuery, countParams);

  return {
    submissions: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

// Get all API keys for admin
async function getAllApiKeys({ limit = 50, offset = 0 } = {}) {
  if (!pool) return { keys: [], total: 0 };

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await pool.query(`SELECT COUNT(*) FROM api_keys`);

  return {
    keys: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

// Revoke API key by ID (admin action)
async function revokeApiKeyById(keyId) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE id = $1 RETURNING *`,
    [keyId]
  );
  return result.rows[0];
}

// Delete API key by ID (admin action)
async function deleteApiKeyById(keyId) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM api_keys WHERE id = $1 RETURNING *`,
    [keyId]
  );
  return result.rows[0];
}

// ==========================================
// Token View tracking operations
// ==========================================

// Increment view count for a token (called when token page is loaded)
async function incrementTokenViews(tokenMint) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO token_views (token_mint, view_count, last_viewed_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (token_mint) DO UPDATE SET
       view_count = token_views.view_count + 1,
       last_viewed_at = NOW()
     RETURNING view_count`,
    [tokenMint]
  );
  return result.rows[0]?.view_count || 0;
}

// Get view count for a token
async function getTokenViews(tokenMint) {
  if (!pool) return 0;

  const result = await pool.query(
    `SELECT view_count FROM token_views WHERE token_mint = $1`,
    [tokenMint]
  );
  return result.rows[0]?.view_count || 0;
}

// Get view counts for multiple tokens (batch)
// Non-critical query - fails gracefully to avoid blocking token list responses
async function getTokenViewsBatch(tokenMints) {
  if (!pool || !tokenMints || tokenMints.length === 0) return {};

  try {
    // Use a shorter timeout for this non-critical query to avoid blocking
    const result = await pool.query({
      text: `SELECT token_mint, view_count FROM token_views WHERE token_mint = ANY($1)`,
      values: [tokenMints],
      statement_timeout: 5000 // 5 second timeout for view counts
    });

    const viewsMap = {};
    result.rows.forEach(row => {
      viewsMap[row.token_mint] = row.view_count;
    });
    return viewsMap;
  } catch (error) {
    // Log but don't crash - view counts are not critical
    console.warn('getTokenViewsBatch failed (non-critical):', error.message);
    return {};
  }
}

// Get most viewed tokens
async function getMostViewedTokens(limit = 10, offset = 0) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT token_mint, view_count, last_viewed_at
     FROM token_views
     ORDER BY view_count DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

// Get distinct token mints that have approved submissions with a given category
async function getTokensByCategory(category, limit = 50, offset = 0) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT DISTINCT s.token_mint
     FROM submissions s
     WHERE s.status = 'approved' AND s.category = $1
     ORDER BY s.token_mint
     LIMIT $2 OFFSET $3`,
    [category, limit, offset]
  );
  return result.rows.map(r => r.token_mint);
}

// ==========================================
// Community Leaderboard operations
// ==========================================

// Get tokens ranked by watchlist count (most watchlisted first)
async function getMostWatchlistedTokens(limit = 25, offset = 0) {
  if (!pool) return { tokens: [], total: 0 };

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT w.token_mint, COUNT(*) AS watchlist_count,
              t.name, t.symbol, t.logo_uri,
              t.price, t.market_cap, t.volume_24h, t.price_change_24h
       FROM watchlist w
       LEFT JOIN tokens t ON w.token_mint = t.mint_address
       GROUP BY w.token_mint, t.name, t.symbol, t.logo_uri,
                t.price, t.market_cap, t.volume_24h, t.price_change_24h
       ORDER BY watchlist_count DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT token_mint) AS total FROM watchlist`
    )
  ]);

  return {
    tokens: dataResult.rows,
    total: parseInt(countResult.rows[0]?.total || 0)
  };
}

// Get tokens ranked by sentiment score (most bullish first)
async function getTopSentimentTokens(limit = 25, offset = 0) {
  if (!pool) return { tokens: [], total: 0 };

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT st.token_mint, st.bullish, st.bearish, st.score,
              t.name, t.symbol, t.logo_uri,
              t.price, t.market_cap, t.volume_24h, t.price_change_24h
       FROM sentiment_tallies st
       LEFT JOIN tokens t ON st.token_mint = t.mint_address
       WHERE (st.bullish + st.bearish) > 0
       ORDER BY st.score DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM sentiment_tallies WHERE (bullish + bearish) > 0`
    )
  ]);

  return {
    tokens: dataResult.rows,
    total: parseInt(countResult.rows[0]?.total || 0)
  };
}

// ==========================================
// Token Call operations
// ==========================================

// Call (endorse) a token — one call per wallet per 24h rolling window
// Uses transaction + advisory lock to prevent race conditions
async function callToken(tokenMint, callerWallet) {
  if (!pool) throw new Error('Database not initialized');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock on wallet to serialize concurrent requests from same wallet
    // Uses a hash of the wallet address as the lock key
    const lockKey = crypto.createHash('sha256').update(callerWallet).digest().readInt32BE(0);
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Check cooldown within the locked transaction
    const cooldownCheck = await client.query(
      `SELECT token_mint, created_at FROM token_calls
       WHERE caller_wallet = $1 AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [callerWallet]
    );

    if (cooldownCheck.rows.length > 0) {
      await client.query('COMMIT');
      const existing = cooldownCheck.rows[0];
      const cooldownEnd = new Date(new Date(existing.created_at).getTime() + 24 * 60 * 60 * 1000);
      return {
        success: false,
        error: 'cooldown',
        existingMint: existing.token_mint,
        cooldownEndsAt: cooldownEnd.toISOString()
      };
    }

    // Fetch market cap separately to avoid PostgreSQL parameter type ambiguity
    const mcapResult = await client.query(
      `SELECT market_cap FROM tokens WHERE mint_address = $1`,
      [tokenMint]
    );
    const mcap = mcapResult.rows[0]?.market_cap ?? null;

    const insertResult = await client.query(
      `INSERT INTO token_calls (token_mint, caller_wallet, mcap_at_call)
       VALUES ($1, $2, $3)
       ON CONFLICT (caller_wallet, token_mint) DO UPDATE
         SET created_at = NOW()
       RETURNING mcap_at_call`,
      [tokenMint, callerWallet, mcap]
    );

    await client.query('COMMIT');
    const mcapRaw = insertResult.rows[0]?.mcap_at_call;
    const mcapAtCall = mcapRaw != null ? parseFloat(mcapRaw) : null;
    return { success: true, mcapAtCall: !isNaN(mcapAtCall) ? mcapAtCall : null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Check cooldown status for a wallet
async function getCallCooldown(callerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT token_mint, created_at FROM token_calls
     WHERE caller_wallet = $1 AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [callerWallet]
  );

  if (result.rows.length === 0) return null;

  const existing = result.rows[0];
  const cooldownEnd = new Date(new Date(existing.created_at).getTime() + 24 * 60 * 60 * 1000);

  return {
    tokenMint: existing.token_mint,
    calledAt: existing.created_at,
    cooldownEndsAt: cooldownEnd.toISOString()
  };
}

// Get tokens ranked by call count in the last 24 hours
async function getMostCalledTokens(limit = 25, offset = 0) {
  if (!pool) return { tokens: [], total: 0 };

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT tc.token_mint, COUNT(*) AS call_count,
              t.name, t.symbol, t.logo_uri,
              t.price, t.market_cap, t.volume_24h, t.price_change_24h
       FROM token_calls tc
       LEFT JOIN tokens t ON tc.token_mint = t.mint_address
       WHERE tc.created_at > NOW() - INTERVAL '24 hours'
       GROUP BY tc.token_mint, t.name, t.symbol, t.logo_uri,
                t.price, t.market_cap, t.volume_24h, t.price_change_24h
       ORDER BY call_count DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT token_mint) AS total
       FROM token_calls
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    )
  ]);

  return {
    tokens: dataResult.rows,
    total: parseInt(countResult.rows[0]?.total || 0)
  };
}

// Get a wallet's full call history with current token data
async function getCallsByWallet(callerWallet, limit = 50, offset = 0) {
  if (!pool) return { calls: [], total: 0 };

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT tc.id, tc.token_mint, tc.mcap_at_call, tc.created_at,
              t.name, t.symbol, t.logo_uri,
              t.price, t.market_cap, t.volume_24h
       FROM token_calls tc
       LEFT JOIN tokens t ON tc.token_mint = t.mint_address
       WHERE tc.caller_wallet = $1
       ORDER BY tc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [callerWallet, limit, offset]
    ),
    pool.query(
      'SELECT COUNT(*) AS total FROM token_calls WHERE caller_wallet = $1',
      [callerWallet]
    )
  ]);

  return {
    calls: dataResult.rows,
    total: parseInt(countResult.rows[0]?.total || 0)
  };
}

// ==========================================
// GDPR Data Deletion operations
// ==========================================

// Delete all user data associated with a wallet (GDPR right to erasure)
async function deleteUserData(walletAddress) {
  if (!pool) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Set a transaction-level timeout for this long-running GDPR deletion
    await client.query('SET LOCAL statement_timeout = 120000'); // 2 minutes

    // Count data before deletion for reporting
    const counts = {
      watchlist: 0,
      votes: 0,
      submissions: 0,
      apiKeys: 0
    };

    // Get counts
    const watchlistCount = await client.query(
      'SELECT COUNT(*) FROM watchlist WHERE wallet_address = $1',
      [walletAddress]
    );
    counts.watchlist = parseInt(watchlistCount.rows[0].count);

    const votesCount = await client.query(
      'SELECT COUNT(*) FROM votes WHERE voter_wallet = $1',
      [walletAddress]
    );
    counts.votes = parseInt(votesCount.rows[0].count);

    const submissionsCount = await client.query(
      'SELECT COUNT(*) FROM submissions WHERE submitter_wallet = $1',
      [walletAddress]
    );
    counts.submissions = parseInt(submissionsCount.rows[0].count);

    const apiKeysCount = await client.query(
      'SELECT COUNT(*) FROM api_keys WHERE owner_wallet = $1',
      [walletAddress]
    );
    counts.apiKeys = parseInt(apiKeysCount.rows[0].count);

    // Delete watchlist entries
    await client.query(
      'DELETE FROM watchlist WHERE wallet_address = $1',
      [walletAddress]
    );

    // Delete votes (and update tallies)
    // Get submission IDs for tally updates
    const voteSubmissions = await client.query(
      'SELECT DISTINCT submission_id FROM votes WHERE voter_wallet = $1',
      [walletAddress]
    );
    const submissionIds = voteSubmissions.rows.map(r => r.submission_id);

    await client.query(
      'DELETE FROM votes WHERE voter_wallet = $1',
      [walletAddress]
    );

    // Update vote tallies for affected submissions in bulk
    if (submissionIds.length > 0) {
      await client.query(
        `UPDATE vote_tallies vt SET
           upvotes = COALESCE(s.up_count, 0),
           downvotes = COALESCE(s.down_count, 0),
           score = COALESCE(s.up_count, 0) - COALESCE(s.down_count, 0),
           weighted_score = COALESCE(s.w_score, 0),
           updated_at = NOW()
         FROM (
           SELECT
             u.id AS submission_id,
             COUNT(*) FILTER (WHERE v.vote_type = 'up') AS up_count,
             COUNT(*) FILTER (WHERE v.vote_type = 'down') AS down_count,
             COALESCE(SUM(CASE WHEN v.vote_type = 'up' THEN v.vote_weight ELSE -v.vote_weight END), 0) AS w_score
           FROM unnest($1::uuid[]) AS u(id)
           LEFT JOIN votes v ON v.submission_id = u.id
           GROUP BY u.id
         ) s
         WHERE vt.submission_id = s.submission_id`,
        [submissionIds]
      );
    }

    // Anonymize submissions (keep content but remove wallet association)
    // We don't delete submissions as they may be approved community content
    await client.query(
      'UPDATE submissions SET submitter_wallet = NULL WHERE submitter_wallet = $1',
      [walletAddress]
    );

    // Delete API keys
    await client.query(
      'DELETE FROM api_keys WHERE owner_wallet = $1',
      [walletAddress]
    );

    // Delete token calls
    const callsCount = await client.query(
      'SELECT COUNT(*) FROM token_calls WHERE caller_wallet = $1',
      [walletAddress]
    );
    counts.tokenCalls = parseInt(callsCount.rows[0].count);

    await client.query(
      'DELETE FROM token_calls WHERE caller_wallet = $1',
      [walletAddress]
    );

    // Delete sentiment votes and update tallies
    const sentimentTokens = await client.query(
      'SELECT DISTINCT token_mint FROM sentiment_votes WHERE voter_wallet = $1',
      [walletAddress]
    );
    counts.sentimentVotes = sentimentTokens.rows.length;

    await client.query(
      'DELETE FROM sentiment_votes WHERE voter_wallet = $1',
      [walletAddress]
    );

    // Recalculate sentiment tallies for affected tokens (batch query)
    if (sentimentTokens.rows.length > 0) {
      const affectedMints = sentimentTokens.rows.map(r => r.token_mint);
      await client.query(
        `UPDATE sentiment_tallies st SET
           bullish = COALESCE(sub.bullish, 0),
           bearish = COALESCE(sub.bearish, 0),
           score = COALESCE(sub.bullish, 0) - COALESCE(sub.bearish, 0),
           updated_at = NOW()
         FROM unnest($1::text[]) AS m(token_mint)
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE sentiment = 'bullish') AS bullish,
             COUNT(*) FILTER (WHERE sentiment = 'bearish') AS bearish
           FROM sentiment_votes sv WHERE sv.token_mint = m.token_mint
         ) sub ON true
         WHERE st.token_mint = m.token_mint`,
        [affectedMints]
      );
    }

    await client.query('COMMIT');

    // Invalidate admin stats cache after data deletion
    invalidateAdminStatsCache();

    return {
      success: true,
      deleted: counts,
      message: 'All user data has been deleted or anonymized'
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// Database Schema Management & Repair
// ==========================================

// Expected submission types (keep in sync with validation.js and init.sql)
const EXPECTED_SUBMISSION_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'];

/**
 * Get current database schema status
 * Checks for missing columns, outdated constraints, etc.
 */
async function getDatabaseSchemaStatus() {
  if (!pool) {
    return { error: 'Database not connected', issues: [], healthy: false };
  }

  const issues = [];
  const checks = [];

  try {
    // Check 1: Verify submissions table exists
    const tablesResult = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('submissions', 'votes', 'tokens', 'vote_tallies')
    `);
    const existingTables = tablesResult.rows.map(r => r.table_name);
    const requiredTables = ['submissions', 'votes', 'tokens', 'vote_tallies'];
    for (const table of requiredTables) {
      if (!existingTables.includes(table)) {
        issues.push({ type: 'missing_table', table, severity: 'critical' });
      }
    }
    checks.push({ name: 'required_tables', passed: issues.length === 0 });

    // Check 2: Verify submission_type constraint includes all expected types
    const constraintResult = await pool.query(`
      SELECT pg_get_constraintdef(oid) as constraint_def
      FROM pg_constraint
      WHERE conrelid = 'submissions'::regclass
      AND conname = 'submissions_submission_type_check'
    `);

    if (constraintResult.rows.length > 0) {
      const constraintDef = constraintResult.rows[0].constraint_def;
      const missingTypes = [];
      for (const type of EXPECTED_SUBMISSION_TYPES) {
        if (!constraintDef.includes(`'${type}'`)) {
          missingTypes.push(type);
        }
      }
      if (missingTypes.length > 0) {
        issues.push({
          type: 'outdated_constraint',
          constraint: 'submissions_submission_type_check',
          missingTypes,
          severity: 'high',
          currentDef: constraintDef
        });
      }
      checks.push({ name: 'submission_type_constraint', passed: missingTypes.length === 0, missingTypes });
    } else {
      issues.push({
        type: 'missing_constraint',
        constraint: 'submissions_submission_type_check',
        severity: 'high'
      });
      checks.push({ name: 'submission_type_constraint', passed: false });
    }

    // Check 3: Verify vote_tallies has weighted_score column
    const weightedScoreResult = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'vote_tallies' AND column_name = 'weighted_score'
    `);
    const hasWeightedScore = weightedScoreResult.rows.length > 0;
    if (!hasWeightedScore) {
      issues.push({
        type: 'missing_column',
        table: 'vote_tallies',
        column: 'weighted_score',
        severity: 'medium'
      });
    }
    checks.push({ name: 'weighted_score_column', passed: hasWeightedScore });

    // Check 4: Verify votes has voter_balance and voter_percentage columns
    const votesColumnsResult = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'votes' AND column_name IN ('voter_balance', 'voter_percentage', 'updated_at')
    `);
    const votesColumns = votesColumnsResult.rows.map(r => r.column_name);
    const missingVotesColumns = ['voter_balance', 'voter_percentage', 'updated_at'].filter(c => !votesColumns.includes(c));
    if (missingVotesColumns.length > 0) {
      issues.push({
        type: 'missing_columns',
        table: 'votes',
        columns: missingVotesColumns,
        severity: 'medium'
      });
    }
    checks.push({ name: 'votes_extra_columns', passed: missingVotesColumns.length === 0, missingColumns: missingVotesColumns });

    // Check 5: Verify submissions has unique constraint on token_mint + submission_type + content_url
    const uniqueConstraintResult = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'submissions'
      AND indexdef LIKE '%token_mint%'
      AND indexdef LIKE '%submission_type%'
      AND indexdef LIKE '%content_url%'
      AND indexdef LIKE '%UNIQUE%'
    `);
    const hasUniqueConstraint = uniqueConstraintResult.rows.length > 0;
    checks.push({ name: 'submissions_unique_constraint', passed: hasUniqueConstraint });
    if (!hasUniqueConstraint) {
      issues.push({
        type: 'missing_index',
        table: 'submissions',
        index: 'unique on (token_mint, submission_type, content_url)',
        severity: 'low'
      });
    }

    return {
      healthy: issues.filter(i => i.severity === 'critical' || i.severity === 'high').length === 0,
      issues,
      checks,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      issues,
      checks: [],
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Repair database schema - apply all pending migrations
 * Returns a report of what was fixed
 */
async function repairDatabaseSchema() {
  if (!pool) {
    return { success: false, error: 'Database not connected', repairs: [] };
  }

  const repairs = [];
  const errors = [];

  try {
    // Get current status to see what needs fixing
    const status = await getDatabaseSchemaStatus();

    for (const issue of status.issues) {
      try {
        switch (issue.type) {
          case 'outdated_constraint':
            if (issue.constraint === 'submissions_submission_type_check') {
              // Drop and recreate the constraint with all types
              await pool.query(`
                ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_submission_type_check
              `);
              await pool.query(`
                ALTER TABLE submissions ADD CONSTRAINT submissions_submission_type_check
                CHECK (submission_type IN ('banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'))
              `);
              repairs.push({
                type: 'constraint_updated',
                constraint: 'submissions_submission_type_check',
                addedTypes: issue.missingTypes
              });
            }
            break;

          case 'missing_constraint':
            if (issue.constraint === 'submissions_submission_type_check') {
              await pool.query(`
                ALTER TABLE submissions ADD CONSTRAINT submissions_submission_type_check
                CHECK (submission_type IN ('banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'))
              `);
              repairs.push({
                type: 'constraint_added',
                constraint: 'submissions_submission_type_check'
              });
            }
            break;

          case 'missing_column':
            if (issue.table === 'vote_tallies' && issue.column === 'weighted_score') {
              await pool.query(`
                ALTER TABLE vote_tallies ADD COLUMN IF NOT EXISTS weighted_score DECIMAL(10,2) DEFAULT 0
              `);
              repairs.push({
                type: 'column_added',
                table: 'vote_tallies',
                column: 'weighted_score'
              });
            }
            break;

          case 'missing_columns':
            if (issue.table === 'votes') {
              for (const col of issue.columns) {
                if (col === 'voter_balance') {
                  await pool.query(`
                    ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_balance DECIMAL(30,10) DEFAULT 0
                  `);
                  repairs.push({ type: 'column_added', table: 'votes', column: 'voter_balance' });
                }
                if (col === 'voter_percentage') {
                  await pool.query(`
                    ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_percentage DECIMAL(10,6) DEFAULT 0
                  `);
                  repairs.push({ type: 'column_added', table: 'votes', column: 'voter_percentage' });
                }
                if (col === 'updated_at') {
                  await pool.query(`
                    ALTER TABLE votes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                  `);
                  repairs.push({ type: 'column_added', table: 'votes', column: 'updated_at' });
                }
              }
            }
            break;

          case 'missing_index':
            if (issue.table === 'submissions') {
              // Create unique index for duplicate prevention (must match initializeDatabase)
              await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_content
                ON submissions(token_mint, submission_type, LOWER(TRIM(TRAILING '/' FROM content_url)))
                WHERE status != 'rejected'
              `);
              repairs.push({
                type: 'index_added',
                table: 'submissions',
                index: 'idx_submissions_unique_content'
              });
            }
            break;

          case 'missing_table':
            // Don't auto-create tables - too risky, require manual init
            errors.push({
              issue,
              error: 'Missing tables must be created manually using init.sql'
            });
            break;
        }
      } catch (repairError) {
        errors.push({
          issue,
          error: repairError.message
        });
      }
    }

    // Get updated status after repairs
    const newStatus = await getDatabaseSchemaStatus();

    return {
      success: errors.length === 0,
      repairs,
      errors,
      previousIssues: status.issues.length,
      remainingIssues: newStatus.issues.length,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      repairs,
      errors,
      timestamp: new Date().toISOString()
    };
  }
}

// Check if database is ready for queries
function isReady() {
  return pool !== null && isConnected;
}

// Check database health
async function checkHealth() {
  if (!pool) {
    return {
      healthy: false,
      error: 'Database pool not initialized',
      isConnected: false
    };
  }

  try {
    const result = await pool.query('SELECT NOW() as time');
    return {
      healthy: true,
      timestamp: result.rows[0].time,
      poolSize: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      isConnected: true
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      isConnected: false
    };
  }
}

// Initialize on load - track initialization promise for proper error handling
let initializationPromise = null;

if (process.env.DATABASE_URL) {
  initializationPromise = initializeDatabase().catch(err => {
    console.error('Critical: Database initialization failed:', err.message);
    // Don't throw - allow app to start without database (graceful degradation)
    return false;
  });
}

// =====================================================
// SENTIMENT VOTING
// =====================================================

async function getSentimentVote(tokenMint, voterWallet) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT sentiment FROM sentiment_votes WHERE token_mint = $1 AND voter_wallet = $2',
    [tokenMint, voterWallet]
  );
  return result.rows[0]?.sentiment || null;
}

async function getSentimentTally(tokenMint) {
  if (!pool) return { bullish: 0, bearish: 0, score: 0 };
  const result = await pool.query(
    'SELECT bullish, bearish, score FROM sentiment_tallies WHERE token_mint = $1',
    [tokenMint]
  );
  return result.rows[0] || { bullish: 0, bearish: 0, score: 0 };
}

async function getSentimentBatch(tokenMints) {
  if (!pool) return {};
  if (!tokenMints || tokenMints.length === 0) return {};
  const result = await pool.query(
    'SELECT token_mint, bullish, bearish, score FROM sentiment_tallies WHERE token_mint = ANY($1)',
    [tokenMints]
  );
  const out = {};
  for (const row of result.rows) {
    out[row.token_mint] = { bullish: row.bullish, bearish: row.bearish, score: row.score };
  }
  return out;
}

async function castSentimentVote(tokenMint, voterWallet, sentiment) {
  if (!pool) throw new Error('Database not initialized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT sentiment FROM sentiment_votes WHERE token_mint = $1 AND voter_wallet = $2',
      [tokenMint, voterWallet]
    );
    const prev = existing.rows[0]?.sentiment || null;

    let action;
    if (!prev) {
      // New vote
      await client.query(
        'INSERT INTO sentiment_votes (token_mint, voter_wallet, sentiment) VALUES ($1, $2, $3)',
        [tokenMint, voterWallet, sentiment]
      );
      const bDelta = sentiment === 'bullish' ? 1 : 0;
      const rDelta = sentiment === 'bearish' ? 1 : 0;
      const sDelta = sentiment === 'bullish' ? 1 : -1;
      await client.query(
        `INSERT INTO sentiment_tallies (token_mint, bullish, bearish, score)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_mint) DO UPDATE SET
           bullish = sentiment_tallies.bullish + $2,
           bearish = sentiment_tallies.bearish + $3,
           score   = sentiment_tallies.score   + $4,
           updated_at = NOW()`,
        [tokenMint, bDelta, rDelta, sDelta]
      );
      action = 'created';
    } else if (prev === sentiment) {
      // Toggle off — remove vote
      await client.query(
        'DELETE FROM sentiment_votes WHERE token_mint = $1 AND voter_wallet = $2',
        [tokenMint, voterWallet]
      );
      const bDelta = sentiment === 'bullish' ? 1 : 0;
      const rDelta = sentiment === 'bearish' ? 1 : 0;
      const sDelta = sentiment === 'bullish' ? 1 : -1;
      await client.query(
        `UPDATE sentiment_tallies SET
           bullish = GREATEST(0, bullish - $2),
           bearish = GREATEST(0, bearish - $3),
           score   = score - $4,
           updated_at = NOW()
         WHERE token_mint = $1`,
        [tokenMint, bDelta, rDelta, sDelta]
      );
      action = 'removed';
    } else {
      // Switch vote (prev !== sentiment)
      await client.query(
        'UPDATE sentiment_votes SET sentiment = $3, updated_at = NOW() WHERE token_mint = $1 AND voter_wallet = $2',
        [tokenMint, voterWallet, sentiment]
      );
      // Switching bullish→bearish: bullish-1, bearish+1, score-2
      // Switching bearish→bullish: bullish+1, bearish-1, score+2
      const bDelta = sentiment === 'bullish' ? 1 : -1;
      const rDelta = sentiment === 'bearish' ? 1 : -1;
      const sDelta = sentiment === 'bullish' ? 2 : -2;
      await client.query(
        `UPDATE sentiment_tallies SET
           bullish = GREATEST(0, bullish + $2),
           bearish = GREATEST(0, bearish + $3),
           score   = score + $4,
           updated_at = NOW()
         WHERE token_mint = $1`,
        [tokenMint, bDelta, rDelta, sDelta]
      );
      action = 'switched';
    }

    const tallyRes = await client.query(
      'SELECT bullish, bearish, score FROM sentiment_tallies WHERE token_mint = $1',
      [tokenMint]
    );
    await client.query('COMMIT');
    return { action, tally: tallyRes.rows[0] || { bullish: 0, bearish: 0, score: 0 } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Get initialization promise for startup checks if needed
function getInitializationPromise() {
  return initializationPromise;
}

// Safe query wrapper - checks pool exists before executing
async function safeQuery(queryFn) {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return queryFn();
}

// ==========================================
// Token Data Repair
// ==========================================

/**
 * Count tokens with placeholder names ('Unknown Token', 'Unknown', etc.)
 */
async function getUnknownTokenCount() {
  if (!pool) return 0;
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM tokens
     WHERE LOWER(name) IN ('unknown token', 'unknown')
        OR symbol IN ('UNKNOWN', '???')
        OR name IS NULL`
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get all tokens with placeholder names.
 * Returns array of mint addresses.
 */
async function getUnknownTokenMints() {
  if (!pool) throw new Error('Database not available');

  const unknowns = await pool.query(
    `SELECT mint_address FROM tokens
     WHERE LOWER(name) IN ('unknown token', 'unknown')
        OR symbol IN ('UNKNOWN', '???')
        OR name IS NULL`
  );

  return unknowns.rows.map(r => r.mint_address);
}

/**
 * Update a token's name/symbol/logo in the database.
 */
async function updateTokenMetadata(mintAddress, name, symbol, logoUri) {
  if (!pool) return;

  await pool.query(
    `UPDATE tokens SET name = $2, symbol = $3, logo_uri = COALESCE($4, logo_uri), updated_at = NOW()
     WHERE mint_address = $1`,
    [mintAddress, name, symbol, logoUri || null]
  );
}

/**
 * Delete tokens by mint addresses.
 * Returns number of deleted rows.
 */
async function deleteTokens(mints) {
  if (!pool || mints.length === 0) return 0;

  const result = await pool.query(
    'DELETE FROM tokens WHERE mint_address = ANY($1)',
    [mints]
  );
  return result.rowCount;
}

// ==========================================
// Folio operations
// ==========================================

async function getAllFolios(activeOnly = true) {
  if (!pool) return [];

  const whereClause = activeOnly ? 'WHERE f.is_active = TRUE' : '';
  const result = await pool.query(
    `SELECT f.*, COUNT(ft.id)::int AS token_count
     FROM folios f
     LEFT JOIN folio_tokens ft ON ft.folio_id = f.id
     ${whereClause}
     GROUP BY f.id
     ORDER BY f.sort_order ASC, f.created_at DESC`
  );
  return result.rows;
}

async function getFolio(id) {
  if (!pool) return null;

  const result = await pool.query('SELECT * FROM folios WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getFolioWithTokens(id) {
  if (!pool) return null;

  const folio = await getFolio(id);
  if (!folio) return null;

  const tokens = await pool.query(
    `SELECT ft.token_mint, ft.note, ft.added_at,
            t.name, t.symbol, t.logo_uri, t.price, t.market_cap, t.volume_24h,
            t.price_change_24h, t.pair_created_at
     FROM folio_tokens ft
     LEFT JOIN tokens t ON t.mint_address = ft.token_mint
     WHERE ft.folio_id = $1
     ORDER BY ft.added_at ASC`,
    [id]
  );

  folio.tokens = tokens.rows;
  return folio;
}

async function createFolio({ name, description, twitterHandle, twitterAvatar, sortOrder }) {
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    `INSERT INTO folios (name, description, twitter_handle, twitter_avatar, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, description || null, twitterHandle, twitterAvatar || null, sortOrder || 0]
  );
  return result.rows[0];
}

async function updateFolio(id, fields) {
  if (!pool) throw new Error('Database not available');

  // Build SET clause dynamically so only provided fields are updated
  // and nullable fields (description, twitterAvatar) can be explicitly cleared
  const setClauses = [];
  const values = [id]; // $1 = id
  let paramIndex = 2;

  const fieldMap = {
    name: 'name',
    description: 'description',
    twitterHandle: 'twitter_handle',
    twitterAvatar: 'twitter_avatar',
    isActive: 'is_active',
    sortOrder: 'sort_order'
  };

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (fields[jsKey] !== undefined) {
      setClauses.push(`${dbCol} = $${paramIndex}`);
      values.push(fields[jsKey]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    return await getFolio(id);
  }

  setClauses.push('updated_at = NOW()');

  const result = await pool.query(
    `UPDATE folios SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function deleteFolio(id) {
  if (!pool) throw new Error('Database not available');

  const result = await pool.query('DELETE FROM folios WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function addFolioToken(folioId, tokenMint, note) {
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    `INSERT INTO folio_tokens (folio_id, token_mint, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (folio_id, token_mint) DO UPDATE SET note = COALESCE($3, folio_tokens.note)
     RETURNING *`,
    [folioId, tokenMint, note || null]
  );
  return result.rows[0];
}

async function removeFolioToken(folioId, tokenMint) {
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    'DELETE FROM folio_tokens WHERE folio_id = $1 AND token_mint = $2 RETURNING id',
    [folioId, tokenMint]
  );
  return result.rowCount > 0;
}

// =====================================================
// CURATED TOKENS
// =====================================================

async function getCuratedTokens() {
  const result = await pool.query(`
    SELECT c.mint_address, c.banner_url, c.socials, c.dexscreener_updated_at, c.added_at,
           t.name, t.symbol, t.logo_uri
    FROM curated_tokens c
    LEFT JOIN tokens t ON t.mint_address = c.mint_address
    ORDER BY c.added_at DESC
  `);
  return result.rows.map(row => ({
    mintAddress: row.mint_address,
    name: row.name || null,
    symbol: row.symbol || null,
    logoUri: row.logo_uri || null,
    bannerUrl: row.banner_url || null,
    socials: row.socials || {},
    dexScreenerUpdatedAt: row.dexscreener_updated_at,
    addedAt: row.added_at
  }));
}

async function getCuratedToken(mintAddress) {
  const result = await pool.query(`
    SELECT c.mint_address, c.banner_url, c.socials, c.dexscreener_updated_at, c.added_at,
           t.name, t.symbol, t.logo_uri
    FROM curated_tokens c
    LEFT JOIN tokens t ON t.mint_address = c.mint_address
    WHERE c.mint_address = $1
  `, [mintAddress]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    mintAddress: row.mint_address,
    name: row.name || null,
    symbol: row.symbol || null,
    logoUri: row.logo_uri || null,
    bannerUrl: row.banner_url || null,
    socials: row.socials || {},
    dexScreenerUpdatedAt: row.dexscreener_updated_at,
    addedAt: row.added_at
  };
}

async function addCuratedToken(mintAddress) {
  const result = await pool.query(`
    INSERT INTO curated_tokens (mint_address) VALUES ($1)
    ON CONFLICT (mint_address) DO NOTHING
    RETURNING *
  `, [mintAddress]);
  return result.rows[0] || null;
}

async function removeCuratedToken(mintAddress) {
  const result = await pool.query(`
    DELETE FROM curated_tokens WHERE mint_address = $1 RETURNING *
  `, [mintAddress]);
  return result.rows[0] || null;
}

async function updateCuratedTokenDexScreener(mintAddress, data) {
  const result = await pool.query(`
    UPDATE curated_tokens
    SET banner_url = $2, socials = $3, dexscreener_updated_at = NOW()
    WHERE mint_address = $1
    RETURNING *
  `, [mintAddress, data.bannerUrl || null, JSON.stringify(data.socials || {})]);
  return result.rows[0] || null;
}

module.exports = {
  get pool() { return pool; },
  initializeDatabase,
  getInitializationPromise,
  isReady,
  safeQuery,
  upsertToken,
  getToken,
  getTokensBatch,
  searchTokens,
  findSimilarTokens,
  createSubmission,
  getSubmission,
  getSubmissionsByToken,
  getApprovedSubmissions,
  getApprovedSubmissionsBatch,
  hasApprovedSubmissionsBatch,
  getSubmissionsByWallet,
  getPendingSubmissions,
  updateSubmissionStatus,
  createVote,
  getVote,
  getVotesBatch,
  updateVote,
  deleteVote,
  getVoteTally,
  checkHealth,
  calculateVoteWeight,
  // Watchlist operations
  addToWatchlist,
  addToWatchlistAtomic,
  removeFromWatchlist,
  getWatchlist,
  isInWatchlist,
  checkWatchlistBatch,
  getWatchlistCount,
  // API Key operations
  createApiKey,
  getApiKeyByHash,
  getApiKeyByWallet,
  updateApiKeyUsage,
  revokeApiKey,
  deleteApiKey,
  hasApiKey,
  // Admin operations
  createAdminSession,
  getAdminSession,
  deleteAdminSession,
  cleanupExpiredAdminSessions,
  getAdminStats,
  invalidateAdminStatsCache,
  getAllSubmissions,
  getAllApiKeys,
  revokeApiKeyById,
  deleteApiKeyById,
  // Token view tracking
  incrementTokenViews,
  getTokenViews,
  getTokenViewsBatch,
  getMostViewedTokens,
  getTokensByCategory,
  getApprovalThreshold,
  // Conviction / Diamond Hands
  upsertConviction,
  getTopConvictionTokens,
  // Community leaderboards
  getMostWatchlistedTokens,
  getTopSentimentTokens,
  // Token calls
  callToken,
  getCallCooldown,
  getMostCalledTokens,
  getCallsByWallet,
  // GDPR data deletion
  deleteUserData,
  // Sentiment voting
  getSentimentVote,
  getSentimentTally,
  getSentimentBatch,
  castSentimentVote,
  // Announcement operations
  getActiveAnnouncements,
  getAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  // Bug report operations
  createBugReport,
  getAllBugReports,
  getBugReport,
  updateBugReportStatus,
  deleteBugReport,
  getBugReportCounts,
  // Database schema management
  getDatabaseSchemaStatus,
  repairDatabaseSchema,
  // Device session operations
  createDeviceSession,
  getDeviceSession,
  activateDeviceSession,
  deleteDeviceSession,
  deleteDeviceSessionsByWallet,
  getDeviceSessionsByWallet,
  cleanupExpiredDeviceSessions,
  DEVICE_SESSION_ACTIVATION_WINDOW_MS,
  DEVICE_SESSION_DURATION_MS,
  // Constants
  AUTO_APPROVE_THRESHOLD,
  AUTO_REJECT_THRESHOLD,
  APPROVAL_THRESHOLDS,
  MIN_REVIEW_MINUTES,
  FIRST_SUBMISSION_REVIEW_MINUTES,
  MIN_VOTE_BALANCE_PERCENT,
  VOTE_WEIGHT_TIERS,
  // Token data repair
  getUnknownTokenCount,
  getUnknownTokenMints,
  updateTokenMetadata,
  deleteTokens,
  // Folio operations
  getAllFolios,
  getFolio,
  getFolioWithTokens,
  createFolio,
  updateFolio,
  deleteFolio,
  addFolioToken,
  removeFolioToken,
  // Curated tokens
  getCuratedTokens,
  getCuratedToken,
  addCuratedToken,
  removeCuratedToken,
  updateCuratedTokenDexScreener
};
