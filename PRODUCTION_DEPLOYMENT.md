# 🚀 Run Forever: Hosting "profileyou" on the Cloud

To run your Auto-DM bot **24/7 forever** without needing your local computer to stay open, you should deploy the Node/Express application to a cloud hosting platform.

---

## 选项 1: Railway (Easiest & Highly Recommended)
[Railway.app](https://railway.app) supports Docker out-of-the-box and provides persistent volumes (crucial for keeping your SQLite database from resetting!).

### Steps to Deploy:
1. Create a free account on **Railway.app**.
2. Connect your GitHub repository containing the code.
3. Add a new service from GitHub repo -> select the `auto-dm` directory.
4. **Setup Environment Variables:**
   Under the **Variables** tab in Railway, add:
   - `PORT=3005`
   - `PAGE_ACCESS_TOKEN=YOUR_PERMANENT_PAGE_TOKEN`
   - `VERIFY_TOKEN=subh_tle_verify_token_123`
   - `DEFAULT_TRIGGER_WORD=pipeline`
   - `DEFAULT_DM_MESSAGE=Hey! Here is the link...`
5. **Setup Persistent SQLite Database Volume:**
   - In Railway, click **+ New** -> **Volume**.
   - Mount the volume at `/app/database.sqlite` (or mount a folder `/app` to persist `database.sqlite`).
6. Click **Deploy**. Railway will build the Docker container and give you a public HTTPS URL (e.g. `https://profileyou-production.up.railway.app`).

---

## 选项 2: Render (Free Tier)
[Render.com](https://render.com) is a great free hosting alternative.

### Steps to Deploy:
1. Create an account on **Render.com**.
2. Click **New +** -> **Web Service**.
3. Connect your GitHub repo.
4. Choose **Docker** as the Environment.
5. In **Advanced Settings**, add the environment variables:
   - `PAGE_ACCESS_TOKEN`
   - `VERIFY_TOKEN`
6. **Add a Disk (Persistent Volume):**
   - Under **Disks**, click **Add Disk**.
   - Name: `sqlite-disk`
   - Mount Path: `/app/data`
   - Size: `1 GB`
   - Change your DB path in code (or environment) to write inside the `/app/data` folder to ensure it doesn't get cleared on redeployment.
7. Click **Deploy Web Service**.

---

## ⚡ What to update on Meta after deploying:
Once your cloud app is live and running, get the new public HTTPS URL provided by your hosting platform (e.g., `https://profileyou-production.up.railway.app`) and update it in your Meta App Settings:

1. Go to your **Meta Developer Dashboard** -> **Webhooks**.
2. Click **Edit Subscription** (संपादित करें).
3. Update the **Callback URL** to:
   `https://profileyou-production.up.railway.app/webhook`
4. Save and subscribe to **`comments`** again.

Your bot will now run 24/7/365, reply instantly to comments, capture leads, and you can access your dashboard from anywhere in the world! 🌐
