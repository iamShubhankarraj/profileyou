const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const APP_ID = '984135980891763'; // From user's screenshots

async function main() {
  console.log('\x1b[35m====================================================\x1b[0m');
  console.log('\x1b[35m   ⚙️ PERMANENT FACEBOOK PAGE ACCESS TOKEN GENERATOR   \x1b[0m');
  console.log('\x1b[35m====================================================\x1b[0m\n');

  // Step 1: Get App Secret
  let appSecret = process.env.APP_SECRET;
  if (!appSecret) {
    appSecret = await askQuestion('🔑 Enter your Meta App Secret (Find it under App Settings -> Basic in Meta Dashboard): ');
  }

  // Step 2: Get Short-Lived User Access Token
  console.log('\n💡 For the token below, use the User Access Token starting with "EAA..." generated from Graph API Explorer.');
  const userToken = await askQuestion('🎟️ Enter short-lived User Access Token: ');

  if (!userToken.startsWith('EAA')) {
    console.error('\x1b[31m\n✕ Error: Token must start with "EAA" (Facebook User Token). The "IGAA" token will not work.\x1b[0m');
    rl.close();
    return;
  }

  try {
    // Step 3: Exchange short-lived token for long-lived User Token (60 days)
    console.log('\n🔄 Exchanging short-lived User Token for 60-day Long-Lived User Token...');
    const exchangeUrl = `https://graph.facebook.com/v20.0/oauth/access_token`;
    const exchangeRes = await axios.get(exchangeUrl, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: APP_ID,
        client_secret: appSecret,
        fb_exchange_token: userToken
      }
    });

    const longLivedUserToken = exchangeRes.data.access_token;
    console.log('\x1b[32m✓ Successfully obtained 60-day Long-Lived User Token.\x1b[0m');

    // Step 4: Fetch Pages and their Permanent Page Access Tokens
    console.log('\n📦 Fetching Pages and generating Permanent Page Access Tokens...');
    const pagesUrl = `https://graph.facebook.com/v20.0/me/accounts`;
    const pagesRes = await axios.get(pagesUrl, {
      params: {
        fields: 'name,access_token,instagram_business_account{id,username}',
        access_token: longLivedUserToken
      }
    });

    const pages = pagesRes.data.data || [];

    if (pages.length === 0) {
      console.log('\x1b[31m✕ No Facebook Pages found linked to this account.\x1b[0m');
      console.log('Please ensure your Facebook account manages a Page and that your Instagram account is linked to it.');
      rl.close();
      return;
    }

    console.log('\n\x1b[32m✓ Found the following Pages & Instagram accounts:\x1b[0m');
    pages.forEach((page, index) => {
      console.log(`\n\x1b[36m[${index + 1}] Page Name: "${page.name}"\x1b[0m`);
      if (page.instagram_business_account) {
        console.log(`    - Connected Instagram: @${page.instagram_business_account.username} (ID: ${page.instagram_business_account.id})`);
      } else {
        console.log('    - Connected Instagram: None (Link your Instagram Business/Creator account to this Page first)');
      }
      console.log(`    - Permanent Page Access Token: \x1b[33m${page.access_token}\x1b[0m`);
    });

    // Step 5: Ask user which page token to save
    const choice = await askQuestion('\n💾 Enter the number of the Page you want to use for Auto-DM: ');
    const pageIndex = parseInt(choice) - 1;

    if (isNaN(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) {
      console.log('\x1b[31mInvalid choice. Exiting without saving.\x1b[0m');
      rl.close();
      return;
    }

    const selectedPage = pages[pageIndex];
    const permanentToken = selectedPage.access_token;

    // Step 6: Update .env file
    console.log(`\n📝 Updating .env file with permanent token for Page "${selectedPage.name}"...`);
    updateEnvFile(permanentToken);

    console.log('\n\x1b[32m🎉 Success! Permanent token is now saved in your .env configuration.\x1b[0m');
    console.log('You can restart your server and use this token forever (it will never expire!).');
    
  } catch (error) {
    const errorMsg = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
    console.error('\x1b[31m\n✕ Error during exchange process:\x1b[0m', errorMsg);
  } finally {
    rl.close();
  }
}

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

function updateEnvFile(token) {
  const envPath = path.join(__dirname, '.env');
  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  // Replace or append PAGE_ACCESS_TOKEN
  const regex = /^PAGE_ACCESS_TOKEN=.*$/m;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `PAGE_ACCESS_TOKEN=${token}`);
  } else {
    envContent += `\nPAGE_ACCESS_TOKEN=${token}`;
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
}

main();
