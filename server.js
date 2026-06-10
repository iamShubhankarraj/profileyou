const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
require('dotenv').config();

const dbHelper = require('./database');
const { requireAuth, mountAuthRoutes } = require('./auth');
const { mountOAuthRoutes } = require('./oauth');
const { decrypt } = require('./crypto-util');

// Uncaught exception and rejection handlers to prevent server crashes and keep it running 24/7
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION] at:', promise, 'reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 3005;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'subh_tle_verify_token_123').trim().replace(/^["']|["']$/g, '');

// Global state to track webhook auto-subscription diagnostics
let subscriptionStatus = {
  status: 'PENDING',
  pageName: null,
  pageId: null,
  error: null,
  timestamp: null
};

// Trust proxy for secure cookies behind reverse proxies (like Render)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());

// ── SESSION MIDDLEWARE ──
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'profileyou-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ── MOUNT AUTH & OAUTH ROUTES (before static files) ──
mountAuthRoutes(app);
mountOAuthRoutes(app);

// Health Check Endpoint for uptime monitoring
app.get('/health', async (req, res) => {
  try {
    await dbHelper.getLogs(1);
    res.json({
      status: 'OK',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (err) {
    console.error('[HEALTH CHECK FAILED]', err);
    res.status(500).json({
      status: 'ERROR',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: err.message
    });
  }
});

// Diagnostics Endpoint for webhook auto-subscription troubleshooting
app.get('/api/diagnostics', async (req, res) => {
  res.json({
    tokenConfigured: Boolean(process.env.PAGE_ACCESS_TOKEN && !process.env.PAGE_ACCESS_TOKEN.includes('your_meta_page_access_token')),
    verifyToken: VERIFY_TOKEN,
    subscription: subscriptionStatus,
    timestamp: new Date().toISOString()
  });
});

// Redirect login page back to root in single-user mode
app.get('/login.html', (req, res) => {
  res.redirect('/');
});

// Serve Static Frontend Dashboard
app.use(express.static(path.join(__dirname, 'public')));

const fs = require('fs');

// Simple logger console helper
const consoleLog = (type, message) => {
  const logLine = `[${new Date().toISOString()}] [${type}] ${message}\n`;
  console.log(`[${type}] ${message}`);
  try {
    fs.appendFileSync(path.join(__dirname, 'app.log'), logLine);
  } catch (err) {
    // Ignore log writing errors
  }
};

// ─── META WEBHOOK VERIFICATION (GET /webhook) ───
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token.trim() === VERIFY_TOKEN) {
      consoleLog('SYSTEM', 'Meta Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      consoleLog('SYSTEM', 'Webhook verification failed: Invalid verify token.');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ─── MULTI-TENANT WEBHOOK LISTENER (POST /webhook) ───
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'instagram' || body.object === 'page') {
    consoleLog('WEBHOOK', 'Received webhook payload');

    if (body.entry && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        // Resolve the user by the Page ID from the webhook entry
        const pageId = entry.id;
        let user = null;
        let userToken = null;

        if (pageId) {
          user = await dbHelper.getUserByPageId(pageId);
          if (user && user.page_access_token_enc) {
            try {
              userToken = decrypt(user.page_access_token_enc);
            } catch (err) {
              consoleLog('ERROR', `Failed to decrypt token for user ${user.id}: ${err.message}`);
            }
          }
        }

        // Fallback: use env token if no user found (backward compatibility / migration)
        if (!userToken) {
          const envToken = process.env.PAGE_ACCESS_TOKEN;
          if (envToken && !envToken.includes('your_meta_page_access_token')) {
            userToken = envToken;
          }
        }

        if (!userToken) {
          consoleLog('WARN', `No token found for Page ID ${pageId}. Skipping entry.`);
          continue;
        }

        // Fallback to User ID 1 if no specific user is resolved (since we disabled authentication)
        const userId = user ? user.id : 1;

        // 1. Handle Inbound DMs (for Story Mentions, Quick Replies, and Email Capture)
        if (entry.messaging && Array.isArray(entry.messaging)) {
          for (const msgEvent of entry.messaging) {
            const senderId = msgEvent.sender ? msgEvent.sender.id : null;
            const message = msgEvent.message;
            
            // A. Detect Story Mentions (User tags us in their Story)
            const attachments = message ? message.attachments : null;
            const isStoryMention = attachments && attachments.some(a => a.type === 'story_mention');
            
            if (isStoryMention) {
              consoleLog('WEBHOOK', `Story mention detected from Sender ID ${senderId}!`);
              const rule = await dbHelper.getAutomationForMedia('DEFAULT', userId);
              if (rule && rule.is_active === 1) {
                const thankMsg = [
                  `Omg! Thank you so much for the Story mention! 🥹💖`,
                  ``,
                  `As a thank you, here is your exclusive link 👇`,
                  ``,
                  rule.dm_message
                ].join('\n');
                
                const recipient = { id: senderId };
                await sendInstagramDmDirect(recipient, thankMsg, userToken);
                await dbHelper.logAutomationRun('STORY_MENTION', senderId, '[Tagged in Story]', 'SUCCESS', null, userId);
              }
              continue;
            }

            // B. Detect Quick Reply / Postback button taps
            let qrPayload = null;
            if (message && message.quick_reply) {
              qrPayload = message.quick_reply.payload;
            } else if (msgEvent.postback) {
              qrPayload = msgEvent.postback.payload;
            }

            if (qrPayload) {
              consoleLog('WEBHOOK', `Button tapped by Sender ID ${senderId} with payload: "${qrPayload}"`);
              
              if (qrPayload.startsWith('CLAIM_FOLLOWED_')) {
                const targetMediaId = qrPayload.replace('CLAIM_FOLLOWED_', '');
                await handleClaimFollowed(senderId, targetMediaId, userToken, userId);
                continue;
              }
              
              if (qrPayload.startsWith('SKIP_EMAIL_')) {
                const targetMediaId = qrPayload.replace('SKIP_EMAIL_', '');
                await handleSkipEmail(senderId, targetMediaId, userToken, userId);
                continue;
              }
            }

            // C. Standard text messages (e.g. email or "skip")
            consoleLog('WEBHOOK', `Received direct message from Sender ID ${senderId}: "${message ? message.text : '[No Text]'}"`);
            if (senderId && message && message.text) {
              await handleInboundDm(senderId, message.text, userToken, userId);
            }
          }
        }

        // 2. Handle Comments and Mentions
        if (entry.changes && Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            if (change.field === 'mentions') {
              const mentionData = change.value;
              if (mentionData) {
                const commentId = mentionData.comment_id;
                const mentionText = mentionData.text || '';
                const senderUsername = mentionData.sender_username || 'unknown';
                
                consoleLog('INFO', `@${senderUsername} mentioned you: "${mentionText}"`);
                
                // Fetch default rule and send a reply if mentioned in a comment
                const rule = await dbHelper.getAutomationForMedia('DEFAULT', userId);
                if (rule && rule.is_active === 1 && commentId) {
                  await sendPublicCommentReply(commentId, `Thanks for tagging me! 💖 Sent you a DM.`, userToken);
                }
              }
            }

            if (change.field === 'comments') {
              const commentData = change.value;
              if (!commentData) continue;

              const commentId = commentData.id;
              const commentText = commentData.text || '';
              const commenterUsername = commentData.from ? commentData.from.username : 'unknown';
              const commenterId = commentData.from ? commentData.from.id : null;
              const mediaId = commentData.media ? commentData.media.id : 'unknown';

              consoleLog('INFO', `Comment detected by @${commenterUsername} on Media ID ${mediaId}: "${commentText}"`);

              try {
                // Find rule (specific or default fallback)
                let rule = await dbHelper.getAutomationForMedia(mediaId, userId);
                
                // If a rule is set to NEXT scope and media_id matches, use it
                const nextRule = await dbHelper.dbGet(`SELECT * FROM automations WHERE scope_type = 'NEXT' AND is_active = 1 AND (user_id = ? OR user_id IS NULL) LIMIT 1`, [userId]);
                if (nextRule && (nextRule.media_id === mediaId || !nextRule.media_id)) {
                  rule = nextRule;
                }

                if (!rule || rule.is_active === 0) {
                  consoleLog('INFO', 'No active rule or fallback configured. Skipping.');
                  continue;
                }

                // Check Excluded Keywords first
                if (rule.excluded_keywords) {
                  const exclusions = rule.excluded_keywords.split(',').map(k => k.trim().toLowerCase());
                  const lowercaseComment = commentText.toLowerCase();
                  const isExcluded = exclusions.some(word => lowercaseComment.includes(word));
                  
                  if (isExcluded) {
                    consoleLog('INFO', `Comment matches excluded keyword. Skipping automation.`);
                    await dbHelper.logAutomationRun(mediaId, commenterUsername, commentText, 'SKIPPED', 'Excluded keyword matched', userId);
                    continue;
                  }
                }

                // Match Keyword (multi-word trigger support, comma separated)
                const triggers = rule.trigger_word.split(',').map(t => t.trim().toLowerCase());
                const cleanComment = commentText.toLowerCase().trim();
                
                const isMatched = triggers.some(trigger => {
                  const matchRegex = new RegExp(`\\b${trigger}\\b`, 'i');
                  return matchRegex.test(cleanComment) || cleanComment.includes(trigger);
                });

                if (isMatched) {
                  consoleLog('INFO', `Trigger word matches for Reel ${mediaId}! Processing reply...`);
                  
                  // Shuffle and send randomized public comment reply
                  if (rule.public_replies) {
                    const replies = rule.public_replies.split(',');
                    const randomReply = replies[Math.floor(Math.random() * replies.length)].trim();
                    await sendPublicCommentReply(commentId, randomReply, userToken);
                  }

                  // ── FOLLOW CHECK GATE ──
                  if (rule.ask_for_follow === 1) {
                    const igUsername = user ? user.ig_username : 'subh.expp';
                    let isFollowing = false;
                    try {
                      isFollowing = await checkIfUserFollows(commenterId, userToken);
                    } catch (err) {
                      consoleLog('WARN', `Initial comment follow check failed (consent/permission error expected): ${err.message}. Defaulting to false (nudge user).`);
                      isFollowing = false;
                    }

                    if (!isFollowing) {
                      consoleLog('INFO', `@${commenterUsername} is not following. Sending follow nudge message with Quick Reply.`);

                      const followNudgeMsg = [
                        `Hey @${commenterUsername}! 👋`,
                        ``,
                        `Thanks for commenting! To unlock your exclusive download link:`,
                        ``,
                        `1️⃣ Go to my profile @${igUsername} (or tap here: https://instagram.com/${igUsername}) and follow`,
                        `2️⃣ Return here & tap 'I follow you!' below!`
                      ].join('\n');

                      const quickReplies = [
                        {
                          content_type: 'text',
                          title: 'I follow you!',
                          payload: `CLAIM_FOLLOWED_${mediaId}`
                        }
                      ];
                      await sendInstagramDm(commentId, followNudgeMsg, userToken, quickReplies);
                      await dbHelper.logAutomationRun(mediaId, commenterUsername, commentText, 'FOLLOW_PENDING', 'Awaiting follow', userId);
                      continue; // ← STOP here, do NOT send the real DM
                    }

                    consoleLog('INFO', `@${commenterUsername} is following ✅. Proceeding to send DM.`);
                  }

                  // ── EMAIL CAPTURE GATE ──
                  if (rule.collect_email === 1) {
                    const cachedEmail = await dbHelper.getContactEmail(commenterUsername);
                    
                    if (cachedEmail) {
                      consoleLog('INFO', `Email for @${commenterUsername} already cached. Dispatching main DM link.`);
                      await sendInstagramDm(commentId, rule.dm_message, userToken);
                      await dbHelper.logAutomationRun(mediaId, commenterUsername, commentText, 'SUCCESS', null, userId);
                    } else {
                      consoleLog('INFO', `Email capture active. Setting conversation state to AWAITING_EMAIL.`);
                      await dbHelper.setConversationState(commenterId || commenterUsername, 'AWAITING_EMAIL', mediaId, userId);
                      
                      const emailPrompt = [
                        `Hey! Almost there 🎉`,
                        ``,
                        `Drop your email address below and I'll send you the exclusive resource right away!`,
                        ``,
                        `📧  Just type your email`,
                        `⏩  Or type "skip" to get the link directly`,
                      ].join('\n');
                      const quickReplies = [
                        {
                          content_type: 'text',
                          title: 'Skip & Get Link ⏩',
                          payload: `SKIP_EMAIL_${mediaId}`
                        }
                      ];
                      await sendInstagramDm(commentId, emailPrompt, userToken, quickReplies);
                    }
                  } else {
                    // ── STANDARD DM RESPONSE ──
                    const success = await sendInstagramDm(commentId, rule.dm_message, userToken);
                    if (success) {
                      await dbHelper.logAutomationRun(mediaId, commenterUsername, commentText, 'SUCCESS', null, userId);
                    } else {
                      await dbHelper.logAutomationRun(mediaId, commenterUsername, commentText, 'FAILED', 'Meta API Send Failed', userId);
                    }
                  }
                } else {
                  consoleLog('INFO', `Comment text does not match trigger keywords.`);
                }
              } catch (err) {
                consoleLog('ERROR', `Error processing comment: ${err.message}`);
              }
            }
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// ─── EMAIL CAPTURE CONVERSATION STATE MACHINE ───
async function handleInboundDm(senderId, text, token, userId) {
  try {
    const stateRecord = await dbHelper.getConversationState(senderId);
    consoleLog('SYSTEM', `Inbound DM state lookup for Sender ${senderId}: ${stateRecord ? stateRecord.state : 'NOT_FOUND'}`);
    if (!stateRecord || stateRecord.state !== 'AWAITING_EMAIL') return;

    const mediaId = stateRecord.media_id;
    const rule = await dbHelper.getAutomationForMedia(mediaId, userId);
    const cleanText = text.trim();

    // Check for Skip command
    if (cleanText.toLowerCase() === 'skip') {
      consoleLog('SYSTEM', `User skipped email verification. Dispatching DM link.`);
      await dbHelper.clearConversationState(senderId);
      
      const recipient = { id: senderId };
      await sendInstagramDmDirect(recipient, rule.dm_message, token);
      await dbHelper.logAutomationRun(mediaId, senderId, '[Email skipped]', 'SUCCESS', null, userId);
      return;
    }

    // Email regex validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const isValidEmail = emailRegex.test(cleanText);

    if (isValidEmail) {
      consoleLog('SYSTEM', `Valid email captured: ${cleanText}. Saving to leads contacts...`);
      
      const resolvedUsername = await resolveInstagramUsername(senderId, token);
      const dbUsername = resolvedUsername !== 'unknown' ? resolvedUsername : senderId;
      
      await dbHelper.saveContactEmail(dbUsername, cleanText, userId);
      await dbHelper.clearConversationState(senderId);

      const confirmMsg = [
        `Thanks for sharing! 🎉`,
        ``,
        `Your email has been saved. Here's your exclusive access link 👇`
      ].join('\n');
      const recipient = { id: senderId };
      await sendInstagramDmDirect(recipient, confirmMsg, token);
      await sendInstagramDmDirect(recipient, rule.dm_message, token);

      await dbHelper.logAutomationRun(mediaId, senderId, `[Email: ${cleanText}]`, 'SUCCESS', null, userId);
    } else {
      consoleLog('SYSTEM', `Invalid email format submitted: "${cleanText}". Retrying...`);
      const retryPrompt = [
        `Hmm, that doesn't look like a valid email 🤔`,
        ``,
        `Please try again with a valid format (e.g. you@email.com)`,
        `Or type "skip" to get the link directly ⏩`
      ].join('\n');
      const recipient = { id: senderId };
      await sendInstagramDmDirect(recipient, retryPrompt, token);
    }
  } catch (err) {
    consoleLog('ERROR', `Error handling inbound DM state: ${err.message}`);
  }
}

// Handle follow claim triggered by Quick Reply tap
async function handleClaimFollowed(senderId, mediaId, token, userId) {
  try {
    let isFollowing = false;
    let apiError = false;
    try {
      isFollowing = await checkIfUserFollows(senderId, token);
    } catch (err) {
      consoleLog('WARN', `Follow check API failed on button tap: ${err.message}. Failing open to prevent stuck loop in production!`);
      isFollowing = true;
      apiError = true;
    }
    const rule = await dbHelper.getAutomationForMedia(mediaId, userId);
    const recipient = { id: senderId };
    const user = await dbHelper.getUserById(userId);
    const igUsername = user && user.ig_username ? user.ig_username : 'subh.expp';

    if (isFollowing) {
      // 1. Send follow success confirmation
      const successMsg = `Awesome! Thanks for the follow! 🎉`;
      await sendInstagramDmDirect(recipient, successMsg, token);

      // 2. Check if we need to collect email
      if (rule.collect_email === 1) {
        const commenterUsername = await resolveInstagramUsername(senderId, token);
        const cachedEmail = await dbHelper.getContactEmail(commenterUsername);

        if (cachedEmail) {
          consoleLog('INFO', `Email for @${commenterUsername} already cached. Dispatching DM link.`);
          await sendInstagramDmDirect(recipient, rule.dm_message, token);
          await dbHelper.logAutomationRun(mediaId, commenterUsername, '[Follow Verified]', 'SUCCESS', null, userId);
        } else {
          consoleLog('INFO', `Email capture active after follow check. Setting conversation state to AWAITING_EMAIL.`);
          await dbHelper.setConversationState(senderId, 'AWAITING_EMAIL', mediaId, userId);

          const emailPrompt = [
            `Drop your email address below and I'll send you the details right away!`,
            ``,
            `⏩  Or tap the button below to get the link directly`
          ].join('\n');

          const quickReplies = [
            {
              content_type: 'text',
              title: 'Skip & Get Link ⏩',
              payload: `SKIP_EMAIL_${mediaId}`
            }
          ];
          await sendInstagramDmDirect(recipient, emailPrompt, token, quickReplies);
          await dbHelper.logAutomationRun(mediaId, commenterUsername, '[Follow Verified]', 'EMAIL_PENDING', 'Awaiting email address', userId);
        }
      } else {
        // Just send the direct DM link
        await sendInstagramDmDirect(recipient, rule.dm_message, token);
        await dbHelper.logAutomationRun(mediaId, senderId, '[Checked follow - Success]', 'SUCCESS', null, userId);
      }
    } else {
      const stillNudgeMsg = [
        `Hmm, it looks like you are not following yet! 🧐`,
        ``,
        `Please follow my profile @${igUsername} (or tap here: https://instagram.com/${igUsername})`,
        ``,
        `Then tap the button below to check again and unlock your link!`
      ].join('\n');
      
      const buttons = [
        {
          type: 'web_url',
          url: `https://instagram.com/${igUsername}`,
          title: 'Follow Profile'
        },
        {
          type: 'postback',
          title: 'I follow you!',
          payload: `CLAIM_FOLLOWED_${mediaId}`
        }
      ];
      await sendInstagramDmButtons(recipient, stillNudgeMsg, buttons, token);
      await dbHelper.logAutomationRun(mediaId, senderId, '[Checked follow - Failed]', 'FOLLOW_PENDING', 'User claimed follow but API returned false', userId);
    }
  } catch (err) {
    consoleLog('ERROR', `Error handling Claim Followed: ${err.message}`);
  }
}

// Handle skipping email collection via Quick Reply tap
async function handleSkipEmail(senderId, mediaId, token, userId) {
  try {
    const rule = await dbHelper.getAutomationForMedia(mediaId, userId);
    await dbHelper.clearConversationState(senderId);
    
    const skipMsg = [
      `No problem! Here is your link directly:`,
      ``,
      rule.dm_message
    ].join('\n');
    
    const recipient = { id: senderId };
    await sendInstagramDmDirect(recipient, skipMsg, token);
    await dbHelper.logAutomationRun(mediaId, senderId, '[Email skipped via Quick Reply]', 'SUCCESS', null, userId);
  } catch (err) {
    consoleLog('ERROR', `Error handling Skip Email via quick reply: ${err.message}`);
  }
}

// Resolve Instagram username from IGSID
async function resolveInstagramUsername(userId, token) {
  if (!userId || !token) return 'unknown';
  try {
    const url = `https://graph.facebook.com/v20.0/${userId}?fields=username&access_token=${token}`;
    const res = await axios.get(url);
    return res.data.username || 'unknown';
  } catch (err) {
    consoleLog('WARN', `Failed to resolve username for IGSID ${userId}: ${err.message}`);
    return 'unknown';
  }
}

// ─── AUXILIARY DM API SENDERS (now accept token parameter) ───

// Check if a user (by IGSID) is following the creator's Instagram account
async function checkIfUserFollows(userId, token) {
  if (!userId || !token) return false; // Default to false if parameters are missing

  try {
    // Query the user profile with the is_user_follow_business field
    const userCheckUrl = `https://graph.facebook.com/v20.0/${userId}?fields=username,is_user_follow_business&access_token=${token}`;
    const userRes = await axios.get(userCheckUrl);
    
    if (userRes.data && typeof userRes.data.is_user_follow_business !== 'undefined') {
      const isFollowing = Boolean(userRes.data.is_user_follow_business);
      consoleLog('INFO', `Follow status for @${userRes.data.username || userId}: ${isFollowing}`);
      return isFollowing;
    }

    consoleLog('WARN', `is_user_follow_business field missing in response. Defaulting to false.`);
    return false; // fail-closed for stricter gatechecking
  } catch (err) {
    consoleLog('WARN', `Follow check API error: ${err.message}. throwing error to caller.`);
    throw err;
  }
}

// Send DM with buttons (link + postback) using comment_id or conversation IGSID
async function sendInstagramDmButtons(recipient, messageText, buttons, token) {
  if (!token) return false;

  try {
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`;
    
    // First, send the text instructions
    try {
      const textPayload = {
        recipient: recipient,
        message: { text: messageText }
      };
      await axios.post(url, textPayload);
    } catch (e) {
      consoleLog('WARN', `Text prefix send failed: ${e.message}`);
    }

    // Then send the Generic Template card containing the buttons (maximum compatibility on Instagram DM)
    const payload = {
      recipient: recipient,
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [
              {
                title: "Follow Gate 🔐",
                subtitle: "Follow to unlock the download link instantly.",
                buttons: buttons
              }
            ]
          }
        }
      }
    };

    const response = await axios.post(url, payload);
    const success = Boolean(response.data && response.data.message_id);
    if (success) {
      consoleLog('SYSTEM', `Buttons sent successfully to ${JSON.stringify(recipient)}! Msg ID: ${response.data.message_id}`);
    } else {
      consoleLog('WARN', `Buttons send returned success but no message_id: ${JSON.stringify(response.data)}`);
    }
    return success;
  } catch (error) {
    consoleLog('ERROR', `Buttons Send Failed: ${error.message} - ${error.response ? JSON.stringify(error.response.data) : ''}`);
    return false;
  }
}

// Reply to a public comment
async function sendPublicCommentReply(commentId, replyText, token) {
  if (!token) return;

  try {
    const url = `https://graph.facebook.com/v20.0/${commentId}/replies?message=${encodeURIComponent(replyText)}&access_token=${token}`;
    await axios.post(url);
    consoleLog('SYSTEM', `Posted public comment reply: "${replyText}"`);
  } catch (err) {
    consoleLog('ERROR', `Failed to write public comment reply: ${err.message}`);
  }
}

// Direct DM using comment_id (first message link)
async function sendInstagramDm(commentId, messageText, token, quickReplies = null) {
  if (!token) return false;

  try {
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`;
    const payload = {
      recipient: { comment_id: commentId },
      message: { text: messageText }
    };
    if (quickReplies && Array.isArray(quickReplies)) {
      payload.message.quick_replies = quickReplies;
    }
    const response = await axios.post(url, payload);
    const success = Boolean(response.data && response.data.message_id);
    if (success) {
      consoleLog('SYSTEM', `DM sent successfully to comment ${commentId}! Msg ID: ${response.data.message_id}`);
    } else {
      consoleLog('WARN', `DM send returned success but no message_id: ${JSON.stringify(response.data)}`);
    }
    return success;
  } catch (error) {
    consoleLog('ERROR', `DM Send Failed: ${error.message} - ${error.response ? JSON.stringify(error.response.data) : ''}`);
    return false;
  }
}

// Direct DM using conversation IGSID (subsequent replies)
async function sendInstagramDmDirect(recipient, messageText, token, quickReplies = null) {
  if (!token) return false;

  try {
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`;
    const payload = {
      recipient: recipient,
      message: { text: messageText }
    };
    if (quickReplies && Array.isArray(quickReplies)) {
      payload.message.quick_replies = quickReplies;
    }
    const response = await axios.post(url, payload);
    const success = Boolean(response.data && response.data.message_id);
    if (success) {
      consoleLog('SYSTEM', `Direct DM sent successfully to ${JSON.stringify(recipient)}! Msg ID: ${response.data.message_id}`);
    } else {
      consoleLog('WARN', `Direct DM send returned success but no message_id: ${JSON.stringify(response.data)}`);
    }
    return success;
  } catch (error) {
    consoleLog('ERROR', `DM Direct Send Failed: ${error.message} - ${error.response ? JSON.stringify(error.response.data) : ''}`);
    return false;
  }
}

// ─── API ENDPOINTS FOR CREATOR DASHBOARD (all auth-protected & user-scoped) ───

// Sync/fetch latest Reels from Instagram Graph API
app.post('/api/media/sync', requireAuth, async (req, res) => {
  try {
    const user = await dbHelper.getUserById(req.userId);
    let token = null;
    if (user && user.page_access_token_enc) {
      token = decrypt(user.page_access_token_enc);
    } else {
      const envToken = process.env.PAGE_ACCESS_TOKEN;
      if (envToken && !envToken.includes('your_meta_page_access_token')) {
        token = envToken;
      }
    }
    
    if (!token) {
      return res.status(400).json({ success: false, error: 'Instagram not connected. Please connect your Instagram account first.' });
    }

    consoleLog('SYSTEM', `Initiating Instagram media sync for user ${req.userId}...`);
    
    // 1. Get linked Instagram Business Account ID
    const pageUrl = `https://graph.facebook.com/v20.0/me?fields=instagram_business_account{id,username}&access_token=${token}`;
    const pageRes = await axios.get(pageUrl);
    
    if (!pageRes.data.instagram_business_account) {
      return res.status(400).json({ success: false, error: 'No connected Instagram Business account found on this Page.' });
    }

    const igAccountId = pageRes.data.instagram_business_account.id;
    const igUsername = pageRes.data.instagram_business_account.username;
    consoleLog('SYSTEM', `Linked Instagram account ID: ${igAccountId} (@${igUsername})`);

    // 2. Fetch latest Reels/posts
    const mediaUrl = `https://graph.facebook.com/v20.0/${igAccountId}/media?fields=id,media_type,media_url,thumbnail_url,permalink,caption,timestamp&limit=25&access_token=${token}`;
    const mediaRes = await axios.get(mediaUrl);
    const mediaPosts = mediaRes.data.data || [];

    // 3. Cache inside SQLite (user-scoped)
    await dbHelper.saveMediaPosts(mediaPosts, req.userId);
    consoleLog('SYSTEM', `Cached ${mediaPosts.length} posts for user ${req.userId}.`);

    // 4. Resolve NEXT post scopes if media ID is empty
    if (mediaPosts.length > 0) {
      const latestPostId = mediaPosts[0].id;
      const nextRule = await dbHelper.dbGet(`SELECT * FROM automations WHERE scope_type = 'NEXT' AND (user_id = ? OR user_id IS NULL) LIMIT 1`, [req.userId]);
      
      if (nextRule && !nextRule.media_id) {
        consoleLog('SYSTEM', `Resolving 'NEXT' scope automation rule. Binding to latest synced Reel: ${latestPostId}`);
        await dbHelper.saveAutomationRule(
          latestPostId,
          nextRule.trigger_word,
          nextRule.dm_message,
          nextRule.is_active,
          nextRule.ask_for_follow,
          'SPECIFIC',
          nextRule.excluded_keywords,
          nextRule.public_replies,
          nextRule.collect_email,
          req.userId
        );
      }
    }

    res.json({ success: true, count: mediaPosts.length });
  } catch (error) {
    const errorMsg = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
    consoleLog('ERROR', `Failed to sync media: ${errorMsg}`);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// List cached Media posts (user-scoped)
app.get('/api/media', requireAuth, async (req, res) => {
  try {
    const posts = await dbHelper.getAllMediaPosts(req.userId);
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Configuration (user-scoped)
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const user = await dbHelper.getUserById(req.userId);
    const configData = await dbHelper.getAutomationConfig(req.userId);
    const hasTokenConfigured = Boolean(
      (user && user.page_access_token_enc) ||
      (process.env.PAGE_ACCESS_TOKEN && !process.env.PAGE_ACCESS_TOKEN.includes('your_meta_page_access_token'))
    );
    res.json({
      success: true,
      ...configData,
      verifyToken: VERIFY_TOKEN,
      hasTokenConfigured: hasTokenConfigured
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / Update Automation Rule (user-scoped)
app.post('/api/config', requireAuth, async (req, res) => {
  const { mediaId, triggerWord, dmMessage, isActive, askForFollow, scopeType, excludedKeywords, publicReplies, collectEmail } = req.body;
  
  if (!mediaId || !triggerWord || !dmMessage) {
    return res.status(400).json({ success: false, error: 'Missing required fields: mediaId, triggerWord, dmMessage' });
  }

  try {
    await dbHelper.saveAutomationRule(
      mediaId,
      triggerWord,
      dmMessage,
      isActive !== undefined ? isActive : 1,
      askForFollow !== undefined ? askForFollow : 0,
      scopeType || 'SPECIFIC',
      excludedKeywords || '',
      publicReplies || '',
      collectEmail !== undefined ? collectEmail : 0,
      req.userId
    );
    consoleLog('SYSTEM', `Automation rule updated for media: ${mediaId} (user ${req.userId})`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Automation Rule
app.delete('/api/config/:mediaId', requireAuth, async (req, res) => {
  const mediaId = req.params.mediaId;
  try {
    await dbHelper.deleteAutomationRule(mediaId);
    consoleLog('SYSTEM', `Automation rule deleted/reset for media: ${mediaId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Leads Contacts (user-scoped)
app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const contacts = await dbHelper.getAllContacts(req.userId);
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get runtime console logs for debugging in production
app.get('/api/debug-logs', async (req, res) => {
  try {
    const logPath = path.join(__dirname, 'app.log');
    if (!fs.existsSync(logPath)) {
      return res.status(200).send('No logs recorded yet.');
    }
    const logContent = fs.readFileSync(logPath, 'utf8');
    // return last 50 lines
    const lines = logContent.split('\n');
    const tailLines = lines.slice(-50).join('\n');
    res.type('text/plain').send(tailLines);
  } catch (err) {
    res.status(500).send(`Error reading logs: ${err.message}`);
  }
});

// Get Logs (user-scoped)
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const logs = await dbHelper.getLogs(100, req.userId);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Logs (user-scoped)
app.post('/api/logs/clear', requireAuth, async (req, res) => {
  try {
    await dbHelper.clearLogs(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Analytics Statistics (user-scoped)
app.get('/api/analytics', requireAuth, async (req, res) => {
  try {
    const summary = await dbHelper.getAnalyticsSummary(req.userId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIMULATION TRIGGER FOR LOCAL TESTING ───
app.post('/api/simulate-comment', requireAuth, async (req, res) => {
  const { username, commentText, mediaId } = req.body;
  const targetMediaId = mediaId || 'DEFAULT';
  const mockCommentId = 'mock_comment_' + Math.floor(Math.random() * 1000000);
  const mockCommenterId = 'mock_user_' + Math.floor(Math.random() * 1000000);

  consoleLog('SYSTEM', `Simulating comment from @${username || 'test_user'} on Media ${targetMediaId}: "${commentText || ''}"`);

  try {
    // Get user's token for simulation
    const user = await dbHelper.getUserById(req.userId);
    let token = null;
    if (user && user.page_access_token_enc) {
      token = decrypt(user.page_access_token_enc);
    } else {
      const envToken = process.env.PAGE_ACCESS_TOKEN;
      if (envToken && !envToken.includes('your_meta_page_access_token')) {
        token = envToken;
      }
    }

    const rule = await dbHelper.getAutomationForMedia(targetMediaId, req.userId);
    
    if (!rule || rule.is_active === 0) {
      return res.json({ success: true, matched: false, message: 'No active rule or fallback configured.' });
    }

    // Check Excluded Keywords
    if (rule.excluded_keywords) {
      const exclusions = rule.excluded_keywords.split(',').map(k => k.trim().toLowerCase());
      const lowercaseComment = (commentText || '').toLowerCase();
      const isExcluded = exclusions.some(word => lowercaseComment.includes(word));
      
      if (isExcluded) {
        consoleLog('INFO', `Simulation matches excluded keyword. Skipping reply.`);
        await dbHelper.logAutomationRun(targetMediaId, username || 'test_user', commentText, 'SKIPPED', 'Excluded keyword matched', req.userId);
        return res.json({ success: true, matched: false, message: 'Simulation skipped: matches excluded keyword.' });
      }
    }

    // Match Keywords
    const triggers = rule.trigger_word.split(',').map(t => t.trim().toLowerCase());
    const cleanComment = (commentText || '').toLowerCase().trim();
    const isMatched = triggers.some(trigger => {
      const matchRegex = new RegExp(`\\b${trigger}\\b`, 'i');
      return matchRegex.test(cleanComment) || cleanComment.includes(trigger);
    });

    if (isMatched) {
      consoleLog('INFO', `Simulation matched rule keyword! Processing simulated reply...`);
      
      // Public reply simulation
      if (rule.public_replies) {
        const replies = rule.public_replies.split(',');
        const randomReply = replies[Math.floor(Math.random() * replies.length)].trim();
        consoleLog('SYSTEM', `Simulated public comment reply: "${randomReply}"`);
      }

      // Follow Check simulation
      if (rule.ask_for_follow === 1) {
        consoleLog('SYSTEM', 'Follow gate active. Sending simulated follow prompt.');
        const igUsername = user && user.ig_username ? user.ig_username : 'subh.expp';
        const followNudgeMsg = [
          `Hey @${username || 'test_user'}! 👋`,
          ``,
          `Thanks for commenting! To unlock your exclusive download link:`,
          ``,
          `1️⃣ Go to my profile @${igUsername} (or tap here: https://instagram.com/${igUsername}) and follow`,
          `2️⃣ Return here & tap 'I follow you!' below!`
        ].join('\n');

        return res.json({
          success: true,
          matched: true,
          needsFollowCheck: true,
          message: followNudgeMsg,
          buttons: [
            {
              type: 'web_url',
              url: `https://instagram.com/${igUsername}`,
              title: 'Follow Profile'
            },
            {
              type: 'postback',
              title: 'I follow you!',
              payload: `CLAIM_FOLLOWED_${targetMediaId}`
            }
          ],
          mockCommentId
        });
      }

      // Email capture simulation
      if (rule.collect_email === 1) {
        const cachedEmail = await dbHelper.getContactEmail(username || 'test_user');
        
        if (cachedEmail) {
          consoleLog('INFO', `Email already cached: ${cachedEmail}. Dispatching DM link.`);
          const success = token ? await sendInstagramDm(mockCommentId, rule.dm_message, token) : false;
          
          if (success) {
            await dbHelper.logAutomationRun(targetMediaId, username || 'test_user', commentText, 'SUCCESS', null, req.userId);
          } else {
            await dbHelper.logAutomationRun(targetMediaId, username || 'test_user', commentText, 'FAILED', 'Meta API Send Failed', req.userId);
          }

          return res.json({
            success: true,
            matched: true,
            message: 'Simulation matched! Email was already cached, DM link dispatched.',
            mockCommentId
          });
        } else {
          consoleLog('INFO', 'Email capture active. Storing conversation state.');
          await dbHelper.setConversationState(mockCommenterId, 'AWAITING_EMAIL', targetMediaId, req.userId);
          
          return res.json({
            success: true,
            matched: true,
            needsEmail: true,
            mockSenderId: mockCommenterId,
            message: 'Simulation matched! Conversation set to AWAITING_EMAIL. Drop an email using the simulator DM inputs.',
            mockCommentId
          });
        }
      } else {
        const success = token ? await sendInstagramDm(mockCommentId, rule.dm_message, token) : false;
        if (success) {
          await dbHelper.logAutomationRun(targetMediaId, username || 'test_user', commentText, 'SUCCESS', null, req.userId);
        } else {
          await dbHelper.logAutomationRun(targetMediaId, username || 'test_user', commentText, 'FAILED', 'Meta API Send Failed', req.userId);
        }

        return res.json({
          success: true,
          matched: true,
          message: success ? 'Simulation matched and DM sent successfully!' : 'Simulation matched, but live DM sending failed (check your token).',
          mockCommentId
        });
      }
    } else {
      consoleLog('INFO', `Simulation did not match triggers.`);
      return res.json({
        success: true,
        matched: false,
        message: `Simulation complete: comment did not match trigger keyword.`
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simulation endpoint for postback buttons (e.g. follow claim)
app.post('/api/simulate-postback', requireAuth, async (req, res) => {
  const { payload, senderId, isFollowing } = req.body;
  if (!payload) {
    return res.status(400).json({ success: false, error: 'Missing payload.' });
  }

  try {
    const user = await dbHelper.getUserById(req.userId);
    const igUsername = user && user.ig_username ? user.ig_username : 'subh.expp';

    if (payload.startsWith('CLAIM_FOLLOWED_')) {
      const targetMediaId = payload.replace('CLAIM_FOLLOWED_', '');
      const rule = await dbHelper.getAutomationForMedia(targetMediaId, req.userId);

      if (isFollowing) {
        return res.json({
          success: true,
          isFollowing: true,
          message: `Awesome! Thanks for the follow! 🎉\n\nHere is your exclusive link 👇`,
          dmMessage: rule.dm_message
        });
      } else {
        return res.json({
          success: true,
          isFollowing: false,
          message: `Hmm, it looks like you are not following yet! 🧐\n\nPlease follow my profile @${igUsername} (or tap here: https://instagram.com/${igUsername})\n\nThen tap the button below to check again and unlock your link!`,
          buttons: [
            {
              type: 'web_url',
              url: `https://instagram.com/${igUsername}`,
              title: 'Follow Profile'
            },
            {
              type: 'postback',
              title: 'I follow you!',
              payload: `CLAIM_FOLLOWED_${targetMediaId}`
            }
          ]
        });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simulation endpoint for replying to email capture prompt
app.post('/api/simulate-dm', requireAuth, async (req, res) => {
  const { senderId, messageText } = req.body;
  if (!senderId || !messageText) {
    return res.status(400).json({ success: false, error: 'Missing senderId or messageText.' });
  }

  try {
    // Get user's token for simulation
    const user = await dbHelper.getUserById(req.userId);
    let token = null;
    if (user && user.page_access_token_enc) {
      token = decrypt(user.page_access_token_enc);
    } else {
      const envToken = process.env.PAGE_ACCESS_TOKEN;
      if (envToken && !envToken.includes('your_meta_page_access_token')) {
        token = envToken;
      }
    }

    consoleLog('SYSTEM', `Simulating DM reply from sender ${senderId}: "${messageText}"`);
    await handleInboundDm(senderId, messageText, token, req.userId);
    res.json({ success: true, message: 'DM simulation parsed.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Automatically subscribe Page to Webhooks if PAGE_ACCESS_TOKEN is configured in environment
async function autoSubscribePage() {
  const envToken = process.env.PAGE_ACCESS_TOKEN;
  if (envToken && !envToken.includes('your_meta_page_access_token')) {
    try {
      consoleLog('SYSTEM', 'Attempting to automatically subscribe Page to the App...');
      subscriptionStatus.status = 'IN_PROGRESS';
      subscriptionStatus.timestamp = new Date().toISOString();

      // 1. Get Page ID
      const meUrl = `https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${envToken}`;
      const meRes = await axios.get(meUrl);
      const pageId = meRes.data.id;
      const pageName = meRes.data.name;
      consoleLog('SYSTEM', `Resolved Page: "${pageName}" (ID: ${pageId})`);
      
      subscriptionStatus.pageId = pageId;
      subscriptionStatus.pageName = pageName;

      // 2. Subscribe Page to Webhook events
      const subscribeUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
      const subscribeRes = await axios.post(subscribeUrl, null, {
        params: {
          subscribed_fields: 'messages,messaging_postbacks,mention,feed',
          access_token: envToken
        }
      });
      
      if (subscribeRes.data && subscribeRes.data.success) {
        consoleLog('SYSTEM', `Successfully subscribed Page "${pageName}" to the Webhook events!`);
        subscriptionStatus.status = 'SUCCESS';
      } else {
        consoleLog('WARN', `Subscription response: ${JSON.stringify(subscribeRes.data)}`);
        subscriptionStatus.status = 'FAILED';
        subscriptionStatus.error = `Response: ${JSON.stringify(subscribeRes.data)}`;
      }
    } catch (err) {
      const errorMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
      consoleLog('ERROR', `Auto-subscription failed: ${errorMsg}`);
      subscriptionStatus.status = 'FAILED';
      subscriptionStatus.error = errorMsg;
    }
  } else {
    consoleLog('SYSTEM', 'No environment PAGE_ACCESS_TOKEN found to auto-subscribe.');
    subscriptionStatus.status = 'NO_TOKEN';
  }
}

// ─── KEEP-ALIVE SYSTEM (Prevents Render Free Tier Spin-Down) ───
// Triple-layer approach to guarantee 24/7 uptime on Render free tier:
// 1. External self-ping via public URL every 4 minutes
// 2. Internal localhost ping every 4 minutes (always works, no env var needed)
// 3. First ping fires 30 seconds after startup (immediate wake confirmation)
function startKeepAlive() {
  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // Render auto-sets this
  const SELF_URL = RENDER_EXTERNAL_URL || process.env.SELF_URL;
  const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (well under 15-min timeout)
  const FIRST_PING_DELAY_MS = 30 * 1000; // 30 seconds after startup

  // Layer 1: Internal localhost ping (always works — no env var needed)
  consoleLog('KEEP-ALIVE', `🏓 Internal keep-alive started — pinging localhost:${PORT}/health every 4 minutes`);
  
  const doLocalPing = async () => {
    try {
      const res = await axios.get(`http://localhost:${PORT}/health`, { timeout: 10000 });
      consoleLog('KEEP-ALIVE', `Local ping OK — uptime: ${Math.round(res.data.uptime)}s, db: ${res.data.database}`);
    } catch (err) {
      consoleLog('KEEP-ALIVE', `Local ping failed: ${err.message}`);
    }
  };

  // Fire first local ping shortly after startup
  setTimeout(doLocalPing, FIRST_PING_DELAY_MS);
  // Then repeat every 4 minutes
  setInterval(doLocalPing, PING_INTERVAL_MS);

  // Layer 2: External self-ping via public URL (generates real inbound traffic)
  if (SELF_URL) {
    const pingUrl = `${SELF_URL}/health`;
    consoleLog('KEEP-ALIVE', `🌐 External keep-alive started — pinging ${pingUrl} every 4 minutes`);

    const doExternalPing = async () => {
      try {
        const res = await axios.get(pingUrl, { timeout: 15000 });
        consoleLog('KEEP-ALIVE', `External ping OK — status: ${res.data.status}, uptime: ${Math.round(res.data.uptime)}s`);
      } catch (err) {
        consoleLog('KEEP-ALIVE', `External ping failed: ${err.message}`);
      }
    };

    // Fire first external ping shortly after startup (staggered from local ping)
    setTimeout(doExternalPing, FIRST_PING_DELAY_MS + 5000);
    // Then repeat every 4 minutes (offset by 2 min from local ping for constant activity)
    setTimeout(() => {
      setInterval(doExternalPing, PING_INTERVAL_MS);
    }, 2 * 60 * 1000);
  } else {
    consoleLog('KEEP-ALIVE', '⚠️ No RENDER_EXTERNAL_URL or SELF_URL set. External ping disabled. Add SELF_URL env var in Render for maximum reliability.');
  }

  consoleLog('KEEP-ALIVE', '✅ Keep-alive system armed — server will NOT spin down!');
}

// Start Server
app.listen(PORT, () => {
  consoleLog('SYSTEM', `profileyou SaaS Engine running on port ${PORT}`);
  consoleLog('SYSTEM', `Webhook Verification Endpoint: http://localhost:${PORT}/webhook`);
  consoleLog('SYSTEM', `Webhook Verification Token: "${VERIFY_TOKEN}"`);
  consoleLog('SYSTEM', `Dashboard: http://localhost:${PORT}`);
  
  // Trigger auto-subscription
  autoSubscribePage();

  // Start keep-alive system to prevent Render spin-down
  startKeepAlive();
});


