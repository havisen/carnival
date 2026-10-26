# Carnival on the Ubuntu VPS

Target: https://carnival.carni.lol on 5.231.61.30.
The server already hosts mailboxes.pw and femalefatadmirer.world through Nginx.
Add only Carnival's own site and service. Do not replace the global Nginx
configuration, change the default site, upgrade the shared Node installation,
or stop the existing web or mail services.

## Layout

- Node 24 or newer; no npm dependencies or build step.
- One process, owned by the dedicated carnival system account.
- Releases: /opt/carnival/releases/<release>; current is a symlink.
- Persistent database, encryption secret, and images: /var/lib/carnival.
- Environment: /etc/carnival/environment, owned by root, mode 0600.
- Service: /etc/systemd/system/carnival.service.
- Listener: 127.0.0.1:3100; only Nginx exposes the app publicly.
- Site: /etc/nginx/sites-available/carnival, linked from sites-enabled.

## First installation

1. Record the existing sites' HTTPS responses and back up their Nginx
   configuration before adding the new site. Check that port 3100 and all
   Carnival paths and account names are available.
2. Create the carnival system account with no interactive shell. Create the
   release directory and /var/lib/carnival; only the latter needs to be writable
   by the app. Upload and extract the runtime archive into the release folder.
   Verify its checksum. Runtime uploads must exclude data, secrets, logs, and
   source-control metadata, and include the track directory and public/.htaccess.
3. Copy environment.example to /etc/carnival/environment and carnival.service
   into systemd. Keep the environment file private. Point current at the release.
4. For a migration, stop writes at the source. Use a SQLite backup rather than
   copying an active database file. Transfer all images and the original
   encryption secret (or preserve the explicitly configured APP_SECRET) over SSH.
   Never generate a replacement secret for an existing database. The bundled
   backup-assets.js copies the database and images, but does not copy secret.key;
   preserve that file separately. Do not commit or include data in runtime bundles.
   For a fresh installation, an empty /var/lib/carnival is sufficient; Carnival
   generates and persists its secret on first start.
5. Run systemd-analyze verify on the unit, reload systemd, and start carnival.
   Check http://127.0.0.1:3100/api/health and confirm the listener is loopback-only.
6. Point the Namecheap A record with Host carnival to 5.231.61.30. Keep existing
   DNS records. Install carnival.http.conf as the Carnival site, create
   /var/www/carnival-acme, and run nginx -t before reloading Nginx.
7. Obtain a certificate without stopping the shared web server:

   certbot certonly --webroot -w /var/www/carnival-acme --cert-name carnival.carni.lol -d carnival.carni.lol --non-interactive --deploy-hook '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx'

   This uses the existing Certbot account. Keep the existing renewal timer.
8. Install carnival.https.conf as the Carnival site; run nginx -t and reload.
   Verify HTTPS, the HTTP redirect, authentication, static assets, and both
   existing websites. Verify certificate renewal for Carnival. Enable carnival
   at boot only after checks pass.

## Updates and rollback

Upload a new runtime-only release, keeping /var/lib/carnival and the environment
file untouched. Back up persistent data and the current symlink target before
switching releases. Run the local mock test suite before upload. Switch current
to the new release and restart only carnival, then check /api/health over HTTPS.

To roll back code, restore the previous symlink target and restart carnival.
If a database migration is incompatible with the old code, stop carnival and
restore its matching data backup and original secret before starting it.
Never restore another app's database or rewrite another Nginx site.

Useful commands: systemctl status carnival; journalctl -u carnival;
systemctl restart carnival; nginx -t; systemctl reload nginx.
