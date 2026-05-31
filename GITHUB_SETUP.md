# GitHub Pages Setup — noahjtaylor.com

Follow these steps to get your site live before NeoCon (June 8).
Estimated time: 15 minutes.

---

## Step 1 — Create a GitHub account

Go to **github.com** and sign up with your email.
Use a professional username — `noahjtaylor` if available.

---

## Step 2 — Create a new repository

1. Click the **+** icon → **New repository**
2. Repository name: `noahjtaylor.com`
3. Set to **Public**
4. Check **Add a README file**
5. Click **Create repository**

---

## Step 3 — Upload your site file

1. In the repository, click **Add file → Upload files**
2. Drag and drop `index.html` from this folder
3. Scroll down, click **Commit changes**

Your file list should now show: `README.md` and `index.html`

---

## Step 4 — Enable GitHub Pages

1. Click **Settings** (top of your repo)
2. Scroll to **Pages** in the left sidebar
3. Under **Source**, select **Deploy from a branch**
4. Branch: `main` / Folder: `/ (root)`
5. Click **Save**

GitHub will give you a URL like: `https://noahjtaylor.github.io/noahjtaylor.com`
Your site is now live at that address within ~2 minutes.

---

## Step 5 — Connect your custom domain (noahjtaylor.com)

### In GitHub Pages settings:
1. Under **Custom domain**, type `noahjtaylor.com`
2. Click **Save**
3. Check **Enforce HTTPS** (wait a few minutes for it to activate)

### In your Squarespace domain settings:
You need to add DNS records pointing to GitHub. Go to your Squarespace account → Domains → DNS settings and add these:

**A Records** (point to GitHub's servers):
```
@ → 185.199.108.153
@ → 185.199.109.153
@ → 185.199.110.153
@ → 185.199.111.153
```

**CNAME Record:**
```
www → noahjtaylor.github.io
```

DNS changes take 10 minutes to 24 hours to propagate. Your site will be live at noahjtaylor.com once it does.

---

## Step 6 — Cancel Squarespace (after DNS propagates)

Once your domain points to GitHub and your site loads at noahjtaylor.com, you can cancel your Squarespace subscription.

---

## Editing the site going forward

To update your site, just:
1. Open `index.html` in any text editor (or ask Claude to edit it)
2. Go to your GitHub repo → click `index.html` → click the pencil icon to edit
3. Or drag a new version over the old one in the Upload files page
4. Commit changes → site updates in ~30 seconds

---

## For NeoCon launch (June 8)

When your new products launch at NeoCon, add a new work item to the `index.html` work list section and a new case study block — Claude can help you write and add those when you're ready.

---

## Questions?

Paste this file into a new Claude conversation along with your `index.html` and ask for help with any step.
