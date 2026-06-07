const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Allow DB path override via environment variable (crucial for cloud persistent volumes like Render/Railway)
const dbPath = process.env.SQLITE_DB_PATH 
  ? path.resolve(process.env.SQLITE_DB_PATH) 
  : path.join(__dirname, 'database.sqlite');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Enable WAL mode & busy timeout for 24/7 reliability
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA busy_timeout=5000");

// Initialize DB schema
db.serialize(() => {
  // ── USERS TABLE (NEW — multi-tenant) ──
  db.run(`
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

  // 1. Media posts table
  db.run(`
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

  // Migration scripts (run if columns are missing in older DB)
  db.run(`ALTER TABLE media_posts ADD COLUMN thumbnail_url TEXT`, (err) => {});
  db.run(`ALTER TABLE media_posts ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

  // 2. Automations table
  db.run(`
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

  // Migration scripts (run if columns are missing in older DB)
  db.run(`ALTER TABLE automations ADD COLUMN scope_type TEXT DEFAULT 'SPECIFIC'`, (err) => {});
  db.run(`ALTER TABLE automations ADD COLUMN excluded_keywords TEXT`, (err) => {});
  db.run(`ALTER TABLE automations ADD COLUMN public_replies TEXT`, (err) => {});
  db.run(`ALTER TABLE automations ADD COLUMN collect_email INTEGER DEFAULT 0`, (err) => {});
  db.run(`ALTER TABLE automations ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

  // Insert default automation row if not exists
  db.run(`
    INSERT OR IGNORE INTO automations (id, media_id, trigger_word, dm_message, is_active, ask_for_follow, scope_type, excluded_keywords, public_replies, collect_email)
    VALUES (1, 'DEFAULT', 'pipeline', 'Hey! Thanks for commenting. Here is the link to the Creator Pipeline files: https://gdrive.link/pipeline', 1, 0, 'ANY', '', 'Check your DMs!,Sent you the link! 📩,Sent! Check your inbox.', 0)
  `);

  // 3. Analytics logs table
  db.run(`
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

  db.run(`ALTER TABLE analytics_logs ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

  // 4. Contacts table (for captured emails)
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      email TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER REFERENCES users(id)
    )
  `);

  db.run(`ALTER TABLE contacts ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});

  // 5. Conversation states table (for email capture workflow)
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_states (
      username TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      media_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER REFERENCES users(id)
    )
  `);

  db.run(`ALTER TABLE conversation_states ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {});
});

// Helper wrapper functions using Promises
const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Export operations
module.exports = {
  db,
  dbGet,
  dbAll,
  dbRun,

  // ── USER MANAGEMENT ──
  createUser: async (email, passwordHash, displayName) => {
    return dbRun(`
      INSERT INTO users (email, password_hash, display_name)
      VALUES (?, ?, ?)
    `, [email, passwordHash, displayName || email.split('@')[0]]);
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
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO media_posts (id, media_url, permalink, caption, media_type, timestamp, thumbnail_url, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        posts.forEach(p => {
          stmt.run(p.id, p.media_url, p.permalink, p.caption, p.media_type, p.timestamp, p.thumbnail_url || null, userId);
        });
        stmt.finalize((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
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
    // 1. Look for specific media post rule for this user
    let rule = await dbGet(`SELECT * FROM automations WHERE media_id = ? AND is_active = 1 AND (user_id = ? OR user_id IS NULL)`, [mediaId, userId]);
    if (!rule) {
      // 2. Fallback to user's default catch-all rule, then global default
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

    const total = counts.total_runs || 0;
    const success = counts.success_runs || 0;
    const rate = total > 0 ? Math.round((success / total) * 100) : 100;

    return {
      totalRuns: total,
      successRuns: success,
      failedRuns: counts.failed_runs || 0,
      skippedRuns: counts.skipped_runs || 0,
      successRate: rate,
      totalLeads: leadsCount.total_leads || 0,
      topReels
    };
  }
};
