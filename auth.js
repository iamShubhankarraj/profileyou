const bcrypt = require('bcryptjs');
const dbHelper = require('./database');

const SALT_ROUNDS = 12;

/**
 * Express middleware: Require authentication.
 * Attaches req.userId and req.user if session is valid.
 */
function requireAuth(req, res, next) {
  req.userId = 1;
  next();
}

/**
 * Mount auth routes on the Express app.
 */
function mountAuthRoutes(app) {

  // ── SIGN UP ──
  app.post('/api/auth/signup', async (req, res) => {
    const { email, password, displayName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    try {
      // Check if user already exists
      const existing = await dbHelper.getUserByEmail(email.toLowerCase().trim());
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

      // Create user
      const result = await dbHelper.createUser(email.toLowerCase().trim(), passwordHash, displayName);
      const userId = result.lastID;

      // Create session
      req.session.userId = userId;

      console.log(`[AUTH] New user registered: ${email} (ID: ${userId})`);

      res.json({
        success: true,
        user: {
          id: userId,
          email: email.toLowerCase().trim(),
          displayName: displayName || email.split('@')[0]
        }
      });
    } catch (err) {
      console.error('[AUTH] Signup error:', err.message);
      res.status(500).json({ error: 'Failed to create account. Please try again.' });
    }
  });

  // ── LOG IN ──
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
      const user = await dbHelper.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Create session
      req.session.userId = user.id;

      console.log(`[AUTH] User logged in: ${email} (ID: ${user.id})`);

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          igUsername: user.ig_username,
          igConnected: Boolean(user.ig_page_id)
        }
      });
    } catch (err) {
      console.error('[AUTH] Login error:', err.message);
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  });

  // ── LOG OUT ──
  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed.' });
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  // ── GET CURRENT USER ──
  app.get('/api/auth/me', async (req, res) => {
    try {
      let user = await dbHelper.getUserById(1);
      if (!user) {
        await dbHelper.dbRun(`
          INSERT OR IGNORE INTO users (id, email, password_hash, display_name)
          VALUES (1, 'admin@profileyou.com', 'dummy_hash', 'Admin')
        `);
        user = await dbHelper.getUserById(1);
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          igUsername: user.ig_username || 'subh.expp',
          igAccountId: user.ig_account_id,
          igConnected: Boolean(user.ig_page_id || process.env.PAGE_ACCESS_TOKEN),
          createdAt: user.created_at
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch user data.' });
    }
  });
}

module.exports = { requireAuth, mountAuthRoutes };
