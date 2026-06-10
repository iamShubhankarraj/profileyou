const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Check if we should use PostgreSQL (DATABASE_URL provided)
const isPostgres = Boolean(process.env.DATABASE_URL);
let pgPool = null;
let sqliteDb = null;

if (isPostgres) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  console.log('[DATABASE] Using PostgreSQL database cluster.');
} else {
  // Allow DB path override via environment variable (crucial for local persistence)
  const dbPath = process.env.SQLITE_DB_PATH 
    ? path.resolve(process.env.SQLITE_DB_PATH) 
    : path.join(__dirname, 'database.sqlite');

  // Ensure database directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  sqliteDb = new sqlite3.Database(dbPath);
  // Enable WAL mode & busy timeout for reliability
  sqliteDb.run("PRAGMA journal_mode=WAL");
  sqliteDb.run("PRAGMA busy_timeout=5000");
  console.log(`[DATABASE] Using SQLite database: ${dbPath}`);
}

/**
 * Translates SQLite-specific queries to PostgreSQL-compatible queries
 */
const translateQuery = (query) => {
  let paramIndex = 1;
  let pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
  pgQuery = pgQuery.replace(/`/g, '"');
  
  if (pgQuery.includes('INSERT OR IGNORE')) {
    pgQuery = pgQuery.replace('INSERT OR IGNORE', 'INSERT');
    if (!pgQuery.includes('ON CONFLICT')) {
      pgQuery += ' ON CONFLICT DO NOTHING';
    }
  }
  
  if (pgQuery.includes('INSERT OR REPLACE')) {
    if (pgQuery.includes('INTO media_posts')) {
      pgQuery = pgQuery.replace('INSERT OR REPLACE', 'INSERT');
      pgQuery += ` ON CONFLICT (id) DO UPDATE SET 
        media_url = EXCLUDED.media_url, 
        permalink = EXCLUDED.permalink, 
        caption = EXCLUDED.caption, 
        media_type = EXCLUDED.media_type, 
        timestamp = EXCLUDED.timestamp, 
        thumbnail_url = EXCLUDED.thumbnail_url, 
        user_id = EXCLUDED.user_id`;
    } else if (pgQuery.includes('INTO contacts')) {
      pgQuery = pgQuery.replace('INSERT OR REPLACE', 'INSERT');
      pgQuery += ` ON CONFLICT (username) DO UPDATE SET 
        email = EXCLUDED.email, 
        user_id = EXCLUDED.user_id`;
    } else if (pgQuery.includes('INTO conversation_states')) {
      pgQuery = pgQuery.replace('INSERT OR REPLACE', 'INSERT');
      pgQuery += ` ON CONFLICT (username) DO UPDATE SET 
        state = EXCLUDED.state, 
        media_id = EXCLUDED.media_id, 
        user_id = EXCLUDED.user_id`;
    }
  }
  return pgQuery;
};

// Helper wrappers using Promises
const dbRun = (query, params = []) => {
  if (!isPostgres) {
    return new Promise((resolve, reject) => {
      sqliteDb.run(query, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  } else {
    return pgPool.query(translateQuery(query), params)
      .then(res => ({ lastID: null, changes: res.rowCount }))
      .catch(err => {
        console.error('[DATABASE ERROR] dbRun failed:', err.message, '\nQuery:', query);
        throw err;
      });
  }
};

const dbAll = (query, params = []) => {
  if (!isPostgres) {
    return new Promise((resolve, reject) => {
      sqliteDb.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  } else {
    return pgPool.query(translateQuery(query), params)
      .then(res => res.rows)
      .catch(err => {
        console.error('[DATABASE ERROR] dbAll failed:', err.message, '\nQuery:', query);
        throw err;
      });
  }
};

const dbGet = (query, params = []) => {
  if (!isPostgres) {
    return new Promise((resolve, reject) => {
      sqliteDb.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  } else {
    return pgPool.query(translateQuery(query), params)
      .then(res => res.rows[0] || null)
      .catch(err => {
        console.error('[DATABASE ERROR] dbGet failed:', err.message, '\nQuery:', query);
        throw err;
      });
  }
};

// Initialize DB schemas asynchronously
const initDatabase = async () => {
  if (!isPostgres) {
    return new Promise((resolve) => {
      sqliteDb.serialize(() => {
        // Users table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            ig_page_id TEXT,
            ig_account_id TEXT,
            ig_username TEXT,
            page_access_token_enc TEXT,
            token_expires_at TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Media posts table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS media_posts (
            id TEXT PRIMARY KEY,
            media_url TEXT,
            permalink TEXT,
            caption TEXT,
            media_type TEXT,
            timestamp TEXT,
            thumbnail_url TEXT,
            user_id INTEGER REFERENCES users(id)
          )
        `);
        
        sqliteDb.run(`ALTER TABLE media_posts ADD COLUMN thumbnail_url TEXT`, (err) => {});
        sqliteDb.run(`ALTER TABLE media_posts ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

        // Automations table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS automations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id TEXT UNIQUE,
            trigger_word TEXT NOT NULL,
            dm_message TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            ask_for_follow INTEGER DEFAULT 0,
            scope_type TEXT DEFAULT 'SPECIFIC',
            excluded_keywords TEXT,
            public_replies TEXT,
            collect_email INTEGER DEFAULT 0,
            user_id INTEGER REFERENCES users(id)
          )
        `);
        
        sqliteDb.run(`ALTER TABLE automations ADD COLUMN scope_type TEXT DEFAULT 'SPECIFIC'`, (err) => {});
        sqliteDb.run(`ALTER TABLE automations ADD COLUMN excluded_keywords TEXT`, (err) => {});
        sqliteDb.run(`ALTER TABLE automations ADD COLUMN public_replies TEXT`, (err) => {});
        sqliteDb.run(`ALTER TABLE automations ADD COLUMN collect_email INTEGER DEFAULT 0`, (err) => {});
        sqliteDb.run(`ALTER TABLE automations ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

        // Insert default automation row if not exists
        sqliteDb.run(`
          INSERT OR IGNORE INTO automations (id, media_id, trigger_word, dm_message, is_active, ask_for_follow, scope_type, excluded_keywords, public_replies, collect_email)
          VALUES (1, 'DEFAULT', 'pipeline', 'Hey! Thanks for commenting. Here is the link to the Creator Pipeline files: https://gdrive.link/pipeline', 1, 0, 'ANY', '', 'Check your DMs!,Sent you the link! 📩,Sent! Check your inbox.', 0)
        `);

        // Analytics logs table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS analytics_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id TEXT,
            commenter_username TEXT,
            comment_text TEXT,
            status TEXT,
            error_message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_id INTEGER REFERENCES users(id)
          )
        `);
        
        sqliteDb.run(`ALTER TABLE analytics_logs ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

        // Contacts table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_id INTEGER REFERENCES users(id)
          )
        `);
        
        sqliteDb.run(`ALTER TABLE contacts ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

        // Conversation states table
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS conversation_states (
            username TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            media_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_id INTEGER REFERENCES users(id)
          )
        `);
        
        sqliteDb.run(`ALTER TABLE conversation_states ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});
        
        resolve();
      });
    });
  } else {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          display_name TEXT,
          ig_page_id TEXT,
          ig_account_id TEXT,
          ig_username TEXT,
          page_access_token_enc TEXT,
          token_expires_at TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS media_posts (
          id TEXT PRIMARY KEY,
          media_url TEXT,
          permalink TEXT,
          caption TEXT,
          media_type TEXT,
          timestamp TEXT,
          thumbnail_url TEXT,
          user_id INTEGER REFERENCES users(id)
        )
      `);
      
      try { await client.query(`ALTER TABLE media_posts ADD COLUMN thumbnail_url TEXT`); } catch(e) {}
      try { await client.query(`ALTER TABLE media_posts ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch(e) {}

      await client.query(`
        CREATE TABLE IF NOT EXISTS automations (
          id SERIAL PRIMARY KEY,
          media_id TEXT UNIQUE,
          trigger_word TEXT NOT NULL,
          dm_message TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          ask_for_follow INTEGER DEFAULT 0,
          scope_type TEXT DEFAULT 'SPECIFIC',
          excluded_keywords TEXT,
          public_replies TEXT,
          collect_email INTEGER DEFAULT 0,
          user_id INTEGER REFERENCES users(id)
        )
      `);
      
      try { await client.query(`ALTER TABLE automations ADD COLUMN scope_type TEXT DEFAULT 'SPECIFIC'`); } catch(e) {}
      try { await client.query(`ALTER TABLE automations ADD COLUMN excluded_keywords TEXT`); } catch(e) {}
      try { await client.query(`ALTER TABLE automations ADD COLUMN public_replies TEXT`); } catch(e) {}
      try { await client.query(`ALTER TABLE automations ADD COLUMN collect_email INTEGER DEFAULT 0`); } catch(e) {}
      try { await client.query(`ALTER TABLE automations ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch(e) {}

      await client.query(`
        INSERT INTO automations (id, media_id, trigger_word, dm_message, is_active, ask_for_follow, scope_type, excluded_keywords, public_replies, collect_email)
        VALUES (1, 'DEFAULT', 'pipeline', 'Hey! Thanks for commenting. Here is the link to the Creator Pipeline files: https://gdrive.link/pipeline', 1, 0, 'ANY', '', 'Check your DMs!,Sent you the link! 📩,Sent! Check your inbox.', 0)
        ON CONFLICT (media_id) DO NOTHING
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS analytics_logs (
          id SERIAL PRIMARY KEY,
          media_id TEXT,
          commenter_username TEXT,
          comment_text TEXT,
          status TEXT,
          error_message TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id)
        )
      `);
      
      try { await client.query(`ALTER TABLE analytics_logs ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch(e) {}

      await client.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE,
          email TEXT NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id)
        )
      `);
      
      try { await client.query(`ALTER TABLE contacts ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch(e) {}

      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_states (
          username TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          media_id TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id)
        )
      `);
      
      try { await client.query(`ALTER TABLE conversation_states ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch(e) {}

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

// Run initialization immediately
initDatabase()
  .then(() => {
    console.log('[DATABASE] Database initialization completed successfully.');
  })
  .catch((err) => {
    console.error('[DATABASE] Database initialization failed:', err);
  });

// Export operations
module.exports = {
  db: isPostgres ? pgPool : sqliteDb,
  dbGet,
  dbAll,
  dbRun,

  // ── USER MANAGEMENT ──
  createUser: async (email, passwordHash, displayName) => {
    const query = `
      INSERT INTO users (email, password_hash, display_name)
      VALUES (?, ?, ?)
    `;
    const params = [email, passwordHash, displayName || email.split('@')[0]];
    if (!isPostgres) {
      return dbRun(query, params);
    } else {
      const pgQuery = translateQuery(query) + ' RETURNING id';
      const result = await pgPool.query(pgQuery, params);
      return { lastID: result.rows[0].id };
    }
  },

  getUserByEmail: async (email) => {
    return dbGet(`SELECT * FROM users WHERE email = ?`, [email]);
  },

  getUserById: async (id) => {
    return dbGet(`SELECT * FROM users WHERE id = ?`, [id]);
  },

  getUserByPageId: async (pageId) => {
    return dbGet(`SELECT * FROM users WHERE ig_page_id = ? OR ig_account_id = ?`, [pageId, pageId]);
  },

  saveUserToken: async (userId, pageId, igAccountId, igUsername, encryptedToken) => {
    return dbRun(`
      UPDATE users SET ig_page_id = ?, ig_account_id = ?, ig_username = ?, page_access_token_enc = ?
      WHERE id = ?
    `, [pageId, igAccountId, igUsername, encryptedToken, userId]);
  },

  disconnectUserInstagram: async (userId) => {
    return dbRun(`
      UPDATE users SET ig_page_id = NULL, ig_account_id = NULL, ig_username = NULL, page_access_token_enc = NULL
      WHERE id = ?
    `, [userId]);
  },

  // ── MEDIA POSTS (user-scoped) ──
  saveMediaPosts: async (posts, userId) => {
    if (!isPostgres) {
      const stmt = sqliteDb.prepare(`
        INSERT OR REPLACE INTO media_posts (id, media_url, permalink, caption, media_type, timestamp, thumbnail_url, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          posts.forEach(p => {
            stmt.run(p.id, p.media_url, p.permalink, p.caption, p.media_type, p.timestamp, p.thumbnail_url || null, userId);
          });
          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    } else {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        for (const p of posts) {
          await client.query(`
            INSERT INTO media_posts (id, media_url, permalink, caption, media_type, timestamp, thumbnail_url, user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              media_url = EXCLUDED.media_url,
              permalink = EXCLUDED.permalink,
              caption = EXCLUDED.caption,
              media_type = EXCLUDED.media_type,
              timestamp = EXCLUDED.timestamp,
              thumbnail_url = EXCLUDED.thumbnail_url,
              user_id = EXCLUDED.user_id
          `, [p.id, p.media_url, p.permalink, p.caption, p.media_type, p.timestamp, p.thumbnail_url || null, userId]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  },

  getAllMediaPosts: async (userId) => {
    return dbAll(`
      SELECT m.*, a.trigger_word, a.dm_message, a.is_active, a.ask_for_follow, a.scope_type, a.excluded_keywords, a.public_replies, a.collect_email
      FROM media_posts m
      LEFT JOIN automations a ON m.id = a.media_id
      WHERE m.user_id = ? OR m.user_id IS NULL
      ORDER BY m.timestamp DESC
    `, [userId]);
  },

  // ── AUTOMATIONS (user-scoped) ──
  getAutomationForMedia: async (mediaId, userId) => {
    let rule = await dbGet(`SELECT * FROM automations WHERE media_id = ? AND is_active = 1 AND (user_id = ? OR user_id IS NULL)`, [mediaId, userId]);
    if (!rule) {
      rule = await dbGet(`SELECT * FROM automations WHERE media_id = 'DEFAULT' AND is_active = 1 AND (user_id = ? OR user_id IS NULL)`, [userId]);
    }
    return rule;
  },

  getAutomationConfig: async (userId) => {
    const automations = await dbAll(`SELECT * FROM automations WHERE user_id = ? OR user_id IS NULL`, [userId]);
    const defaultRule = automations.find(a => a.media_id === 'DEFAULT') || {
      trigger_word: 'pipeline',
      dm_message: 'Hey! Thanks for commenting. Here is the link to the Creator Pipeline files: https://gdrive.link/pipeline',
      is_active: 1,
      ask_for_follow: 0,
      scope_type: 'ANY',
      excluded_keywords: '',
      public_replies: 'Check your DMs!,Sent you the link! 📩,Sent! Check your inbox.',
      collect_email: 0
    };
    return { automations, defaultRule };
  },

  saveAutomationRule: async (mediaId, triggerWord, dmMessage, isActive = 1, askForFollow = 0, scopeType = 'SPECIFIC', excludedKeywords = '', publicReplies = '', collectEmail = 0, userId = null) => {
    return dbRun(`
      INSERT INTO automations (media_id, trigger_word, dm_message, is_active, ask_for_follow, scope_type, excluded_keywords, public_replies, collect_email, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET
        trigger_word = excluded.trigger_word,
        dm_message = excluded.dm_message,
        is_active = excluded.is_active,
        ask_for_follow = excluded.ask_for_follow,
        scope_type = excluded.scope_type,
        excluded_keywords = excluded.excluded_keywords,
        public_replies = excluded.public_replies,
        collect_email = excluded.collect_email,
        user_id = excluded.user_id
    `, [mediaId, triggerWord, dmMessage, isActive, askForFollow, scopeType, excludedKeywords, publicReplies, collectEmail, userId]);
  },

  deleteAutomationRule: async (mediaId) => {
    if (mediaId === 'DEFAULT') return; // Cannot delete default rule
    return dbRun(`DELETE FROM automations WHERE media_id = ?`, [mediaId]);
  },

  // ── CONTACTS / LEADS (user-scoped) ──
  saveContactEmail: async (username, email, userId) => {
    return dbRun(`
      INSERT OR REPLACE INTO contacts (username, email, user_id)
      VALUES (?, ?, ?)
    `, [username, email, userId]);
  },

  getContactEmail: async (username) => {
    return dbGet(`SELECT email FROM contacts WHERE username = ?`, [username]);
  },

  getAllContacts: async (userId) => {
    return dbAll(`SELECT * FROM contacts WHERE user_id = ? OR user_id IS NULL ORDER BY timestamp DESC`, [userId]);
  },

  // ── CONVERSATION STATE TRACKING ──
  setConversationState: async (username, state, mediaId, userId) => {
    return dbRun(`
      INSERT OR REPLACE INTO conversation_states (username, state, media_id, user_id)
      VALUES (?, ?, ?, ?)
    `, [username, state, mediaId, userId]);
  },

  getConversationState: async (username) => {
    return dbGet(`SELECT * FROM conversation_states WHERE username = ?`, [username]);
  },

  clearConversationState: async (username) => {
    return dbRun(`DELETE FROM conversation_states WHERE username = ?`, [username]);
  },

  // ── LOGS / ANALYTICS (user-scoped) ──
  logAutomationRun: async (mediaId, commenter, text, status, errorMsg = null, userId = null) => {
    return dbRun(`
      INSERT INTO analytics_logs (media_id, commenter_username, comment_text, status, error_message, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [mediaId, commenter, text, status, errorMsg, userId]);
  },

  getLogs: async (limit = 100, userId = null) => {
    if (userId) {
      return dbAll(`
        SELECT l.*, m.permalink, m.caption
        FROM analytics_logs l
        LEFT JOIN media_posts m ON l.media_id = m.id
        WHERE l.user_id = ? OR l.user_id IS NULL
        ORDER BY l.timestamp DESC
        LIMIT ?
      `, [userId, limit]);
    }
    return dbAll(`
      SELECT l.*, m.permalink, m.caption
      FROM analytics_logs l
      LEFT JOIN media_posts m ON l.media_id = m.id
      ORDER BY l.timestamp DESC
      LIMIT ?
    `, [limit]);
  },

  clearLogs: async (userId) => {
    if (userId) {
      return dbRun(`DELETE FROM analytics_logs WHERE user_id = ?`, [userId]);
    }
    return dbRun(`DELETE FROM analytics_logs`);
  },

  getAnalyticsSummary: async (userId) => {
    const userFilter = userId ? `WHERE user_id = ${userId} OR user_id IS NULL` : '';
    const counts = await dbGet(`
      SELECT 
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as success_runs,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed_runs,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped_runs
      FROM analytics_logs
      ${userFilter}
    `);
    
    const leadsFilter = userId ? `WHERE user_id = ${userId} OR user_id IS NULL` : '';
    const leadsCount = await dbGet(`SELECT COUNT(*) as total_leads FROM contacts ${leadsFilter}`);

    const topReels = await dbAll(`
      SELECT l.media_id, m.caption, m.permalink, COUNT(*) as trigger_count
      FROM analytics_logs l
      JOIN media_posts m ON l.media_id = m.id
      WHERE l.status = 'SUCCESS' ${userId ? `AND (l.user_id = ${userId} OR l.user_id IS NULL)` : ''}
      GROUP BY l.media_id
      ORDER BY trigger_count DESC
      LIMIT 5
    `);

    const total = parseInt(counts.total_runs || 0, 10);
    const success = parseInt(counts.success_runs || 0, 10);
    const failed = parseInt(counts.failed_runs || 0, 10);
    const skipped = parseInt(counts.skipped_runs || 0, 10);
    const rate = total > 0 ? Math.round((success / total) * 100) : 100;
    const totalLeads = parseInt(leadsCount.total_leads || 0, 10);

    return {
      totalRuns: total,
      successRuns: success,
      failedRuns: failed,
      skippedRuns: skipped,
      successRate: rate,
      totalLeads,
      topReels
    };
  }
};
