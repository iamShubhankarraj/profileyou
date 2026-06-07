const axios = require('axios');
const dbHelper = require('./database');
const { encrypt } = require('./crypto-util');

const FB_API_VERSION = 'v20.0';

/**
 * Mount Facebook OAuth routes on the Express app.
 */
function mountOAuthRoutes(app) {

  // ── START FACEBOOK LOGIN ──
  // Redirects the user to Facebook's OAuth dialog
  app.get('/api/oauth/facebook', (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/login.html?error=Please+log+in+first');
    }

    const appId = process.env.FB_APP_ID;
    const redirectUri = process.env.FB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/oauth/facebook/callback`;

    if (!appId) {
      return res.status(500).send('Facebook App ID not configured. Set FB_APP_ID in .env');
    }

    const scopes = [
      'pages_show_list',
      'pages_messaging',
      'instagram_basic',
      'instagram_manage_messages',
      'instagram_manage_comments'
    ].join(',');

    const authUrl = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?` +
      `client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scopes}` +
      `&response_type=code` +
      `&state=${req.session.userId}`;

    console.log(`[OAUTH] Redirecting user ${req.session.userId} to Facebook Login`);
    res.redirect(authUrl);
  });

  // ── FACEBOOK OAUTH CALLBACK ──
  // Exchanges the code for a token, finds the linked IG account, stores encrypted token
  app.get('/api/oauth/facebook/callback', async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error(`[OAUTH] Facebook returned error: ${error} — ${error_description}`);
      return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
      return res.redirect('/?oauth_error=No+authorization+code+received');
    }

    if (!req.session || !req.session.userId) {
      return res.redirect('/login.html?error=Session+expired');
    }

    const userId = req.session.userId;
    const appId = process.env.FB_APP_ID;
    const appSecret = process.env.FB_APP_SECRET;
    const redirectUri = process.env.FB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/oauth/facebook/callback`;

    try {
      // 1. Exchange code for short-lived user access token
      console.log('[OAUTH] Exchanging code for access token...');
      const tokenRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code: code
        }
      });

      const userAccessToken = tokenRes.data.access_token;

      // 2. Exchange for long-lived token (60 days)
      console.log('[OAUTH] Exchanging for long-lived token...');
      const longLivedRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: userAccessToken
        }
      });

      const longLivedUserToken = longLivedRes.data.access_token;

      // 3. Get user's Facebook Pages
      console.log('[OAUTH] Fetching user\'s Facebook Pages...');
      const pagesRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, {
        params: {
          access_token: longLivedUserToken,
          fields: 'id,name,access_token,instagram_business_account{id,username}'
        }
      });

      const pages = pagesRes.data.data || [];
      
      // Find the first page with a connected Instagram Business Account
      let selectedPage = null;
      for (const page of pages) {
        if (page.instagram_business_account) {
          selectedPage = page;
          break;
        }
      }

      if (!selectedPage) {
        console.error('[OAUTH] No page with connected Instagram Business Account found');
        return res.redirect('/?oauth_error=No+Instagram+Business+Account+found.+Please+connect+your+Instagram+to+a+Facebook+Page+first.');
      }

      const pageAccessToken = selectedPage.access_token; // Never-expiring Page access token
      const pageId = selectedPage.id;
      const igAccountId = selectedPage.instagram_business_account.id;
      const igUsername = selectedPage.instagram_business_account.username;

      // 4. Encrypt and store the token
      const encryptedToken = encrypt(pageAccessToken);
      await dbHelper.saveUserToken(userId, pageId, igAccountId, igUsername, encryptedToken);

      // Subscribe Page to the App Webhook events
      try {
        console.log(`[OAUTH] Subscribing Page ${pageId} to the App webhooks...`);
        const subscribeUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
        await axios.post(subscribeUrl, null, {
          params: {
            subscribed_fields: 'messages,comments,mention',
            access_token: pageAccessToken
          }
        });
        console.log(`[OAUTH] Webhook subscription verified for Page ID ${pageId}`);
      } catch (subErr) {
        console.error(`[OAUTH] Failed to subscribe Page ${pageId} to app:`, subErr.response?.data || subErr.message);
      }

      console.log(`[OAUTH] Successfully connected Instagram @${igUsername} for user ${userId}`);
      
      // Redirect back to dashboard with success
      res.redirect('/?oauth_success=Instagram+connected+successfully');

    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.error('[OAUTH] Token exchange failed:', errorMsg);
      res.redirect(`/?oauth_error=${encodeURIComponent('Connection failed: ' + errorMsg)}`);
    }
  });

  // ── DISCONNECT INSTAGRAM ──
  app.post('/api/oauth/disconnect', async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    try {
      await dbHelper.disconnectUserInstagram(req.session.userId);
      console.log(`[OAUTH] User ${req.session.userId} disconnected Instagram`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to disconnect.' });
    }
  });
}

module.exports = { mountOAuthRoutes };
