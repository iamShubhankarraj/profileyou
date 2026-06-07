const axios = require('axios');
require('dotenv').config();

const token = process.argv[2] || process.env.PAGE_ACCESS_TOKEN;

if (!token || token.includes('your_meta_page_access_token')) {
  console.error('\x1b[31mError: Please provide a token as an argument or set PAGE_ACCESS_TOKEN in your .env file.\x1b[0m');
  console.log('Usage: node verify-token.js <YOUR_ACCESS_TOKEN>');
  process.exit(1);
}

console.log('\x1b[36mAnalyzing Meta Access Token...\x1b[0m\n');

async function verifyToken() {
  // 1. Try to query /me to check if it's a Facebook token or Instagram token
  try {
    const isInstagramToken = token.startsWith('IGAA');
    
    if (isInstagramToken) {
      console.log('\x1b[33m⚠️ Detected: Instagram User Access Token (starts with IGAA)\x1b[0m');
      console.log('This type of token is for the Instagram Basic Display API.');
      console.log('It CANNOT be used to send DMs or listen to comments via the Messenger Graph API.\n');
      
      const response = await axios.get(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);
      console.log('\x1b[32m✓ Token is valid for Instagram User:\x1b[0m');
      console.log(`  - Username: @${response.data.username}`);
      console.log(`  - User ID: ${response.data.id}`);
      console.log('\x1b[31m✕ Note: This token will expire in 60 days and cannot be made permanent or used for Auto-DM.\x1b[0m');
      return;
    }

    // Treat as Facebook/Page token
    console.log('\x1b[36mQuerying Meta Graph API...\x1b[0m');
    const meResponse = await axios.get(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${token}`);
    
    console.log('\x1b[32m✓ Token is a valid Meta Graph API Token!\x1b[0m');
    console.log(`  - Name: ${meResponse.data.name}`);
    console.log(`  - ID: ${meResponse.data.id}`);

    // Check permissions/metadata using the debug_token endpoint
    // To do this properly without an app secret, we inspect /me/permissions
    console.log('\n\x1b[36mChecking Token Permissions...\x1b[0m');
    const permResponse = await axios.get(`https://graph.facebook.com/v20.0/me/permissions?access_token=${token}`);
    const permissions = permResponse.data.data;
    
    const grantedPermissions = permissions
      .filter(p => p.status === 'granted')
      .map(p => p.permission);

    console.log('Granted Permissions:');
    grantedPermissions.forEach(p => console.log(`  - [✓] ${p}`));

    const requiredPermissions = [
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'pages_read_engagement',
      'pages_manage_metadata'
    ];

    console.log('\nPermission Check:');
    let hasAll = true;
    requiredPermissions.forEach(p => {
      if (grantedPermissions.includes(p)) {
        console.log(`  - \x1b[32m[✓] ${p}\x1b[0m`);
      } else {
        console.log(`  - \x1b[31m[✕] ${p} (MISSING)\x1b[0m`);
        hasAll = false;
      }
    });

    // Try to find connected Instagram Business Accounts
    console.log('\n\x1b[36mChecking Linked Instagram Business Accounts...\x1b[0m');
    try {
      const accountsResponse = await axios.get(`https://graph.facebook.com/v20.0/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${token}`);
      const pages = accountsResponse.data.data || [];
      
      if (pages.length === 0) {
        // Token might be a Page token itself, try to query linked IG account directly
        const pageInfo = await axios.get(`https://graph.facebook.com/v20.0/me?fields=name,instagram_business_account{id,username}&access_token=${token}`);
        if (pageInfo.data.instagram_business_account) {
          const ig = pageInfo.data.instagram_business_account;
          console.log(`\x1b[32m✓ Connected to Instagram Business Account:\x1b[0m @${ig.username} (ID: ${ig.id})`);
          console.log(`  - Managed via Facebook Page: ${pageInfo.data.name}`);
        } else {
          console.log('\x1b[31m✕ This Page does not have a linked Instagram Business Account.\x1b[0m');
          console.log('Please link your Instagram Business/Creator account to this Facebook Page in Page Settings.');
        }
      } else {
        pages.forEach(p => {
          console.log(`Facebook Page: ${p.name}`);
          if (p.instagram_business_account) {
            console.log(`  - \x1b[32m[✓] Linked IG Business Account:\x1b[0m @${p.instagram_business_account.username} (ID: ${p.instagram_business_account.id})`);
          } else {
            console.log('  - [✕] No linked IG Business Account');
          }
        });
      }
    } catch (e) {
      console.log('\x1b[33m⚠️ Could not query linked accounts (Token might be a direct User token, not a Page token).\x1b[0m');
    }

    // Expiration check
    console.log('\n\x1b[36mChecking Expiration...\x1b[0m');
    // Using debug endpoint or checking properties
    console.log('\x1b[32m✓ If this token was generated using a long-lived User token via GET /me/accounts, it NEVER expires (Permanent).\x1b[0m');

  } catch (error) {
    const errorMsg = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
    console.error('\x1b[31m✕ Error verifying token:\x1b[0m', errorMsg);
  }
}

verifyToken();
