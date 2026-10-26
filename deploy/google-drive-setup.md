# Connect Google Drive to Carnival

Carnival uses a server-side OAuth web client and the `drive.file` scope. Each
Carnival user connects their own Google account. Carnival can save Library images
with a JSON file containing their prompts and provenance, browse the Carnival
images in that Drive account, and import those images and prompts into Library.

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create
   a project and enable **Google Drive API** under APIs & Services → Library.
2. Configure **Google Auth Platform** (or OAuth consent screen): app name
   Carnival, your support email, audience, and developer contact. If the app is
   in testing, add the Google accounts that will connect as test users.
3. Add this data-access scope: `https://www.googleapis.com/auth/drive.file`.
   This limits access to files the app creates or the user grants to the app.
4. Create an OAuth client with application type **Web application**. Add this
   exact **Authorized redirect URI**:

   `https://carnival.carni.lol/api/drive/callback`

5. On the VPS, edit the existing Carnival environment file:

   ```sh
   ssh root@5.231.61.30
   nano /etc/carnival/environment
   ```

   Keep every existing setting, including DATA_DIR, PUBLIC_ORIGIN, and any
   encryption secret. Add your client values on separate lines:

   ```text
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

   Do not paste the secret into chat, source code, or a Git commit.

6. Keep the file private and restart only Carnival:

   ```sh
   chmod 600 /etc/carnival/environment
   systemctl restart carnival
   systemctl is-active carnival
   ```

7. Sign into Carnival. Open **Library → Google Drive → Connect Google Drive**
   and approve the Google consent screen. Back in Carnival, open an image's
   details and click **Save image & prompt to Google Drive**. **Browse Carnival
   files** lists exported images and offers **Import to Library**.

If Google reports `redirect_uri_mismatch`, check the exact URI above, including
HTTPS and `/api/drive/callback`. If access is blocked in testing, add your Google
account to the consent screen's test users. After changing the OAuth client,
disconnect and reconnect in Carnival.

**Disconnect** removes Carnival's stored access and refresh credentials. You can
also revoke Carnival in your Google account's third-party connections. Disconnect
does not delete images already saved in Drive or Library.

Sources: [Google web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Drive upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
