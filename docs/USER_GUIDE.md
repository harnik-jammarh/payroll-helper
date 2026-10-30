# Odoo Payroll Helper 1.2.0

## Install or update
Close the previous app, then run from the downloaded file's directory:

    sudo apt install ./odoo-payroll-helper_1.2.0_all.deb
    odoo-payroll-helper

Each launch asks you to choose Brave, Firefox, Chrome or Chromium. Unavailable
browsers are disabled. Install your preferred browser separately. The package
installs Python 3 and Tk through apt. No extension installation is required.
Closing the small running-status window minimizes it; the service stays running.
Stop application shuts down the local service; close its browser tabs afterwards.
Launching again allows selecting another browser and reuses the running service.

## Data and updates
Payroll data is stored independently of your browser at:

    ~/.local/share/odoo-payroll-helper/payroll.json

Updates and switching browsers use this same file. Updates do not remove user
data. Saves are atomic; payroll.previous.json retains the preceding save. These
files include your API key and are readable only by your Linux user by default.
Export JSON backups regularly; exports intentionally exclude the API key.
Avoid restoring a backup while editing in another tab: the last saved state wins.

Existing extension profiles from 1.0.0 and 1.0.1 are left untouched. To transfer
existing Chrome-extension data, export a JSON backup from the original working
extension, import it in this app, and re-enter your API key. The program does not
read Chromium's internal LevelDB storage automatically. If you have no existing
payroll data, configure the connection and start normally.

## Odoo connection
Use your HTTPS Odoo URL. API-key mode works without a companion. Logged-in-tab
mode uses Payroll Tab Companion in the same browser and profile as your Odoo tab.
The app finds tabs matching the configured Odoo origin and prefers an active tab.
If multiple matching tabs exist, keep the desired company/session active.

### Install the companion: Chrome / Brave / Chromium
Extract payroll-tab-companion-chrome.zip to a permanent folder in your home.
Open chrome://extensions (Chrome/Chromium) or brave://extensions (Brave), enable
Developer mode, choose Load unpacked, and select the extracted folder containing
manifest.json. Do not load the ZIP directly. Allow the requested site access.
After companion updates, replace those files and click Reload on that extension.

### Install the companion: Firefox 128 or later
Extract payroll-tab-companion-firefox.zip. Open about:debugging#/runtime/this-firefox,
click Load Temporary Add-on, and select the extracted manifest.json. Grant Odoo
site access if prompted. This unsigned add-on lasts until Firefox restarts; reload
it after a restart. Permanent release-Firefox installation requires Mozilla signing,
which is not included in these artifacts.

### Enable logged-in-tab access
1. Open and log in to your HTTPS Odoo site in the selected browser/profile.
2. Open the local payroll app and reload its page after installing the companion.
3. The companion verifies the local Payroll Helper session automatically.
4. Select My logged-in Odoo tab, enter the Odoo URL, and click Connect.

Verification is specific to the local session URL and the saved Odoo origin. The extension uses
your existing Odoo session; it does not copy cookies or require an API key. Other
browser profiles and private/incognito tabs are separate sessions. Normal Odoo
user permissions still apply, including payroll journal operations.
The companion source is also installed under
/usr/share/odoo-payroll-helper/companion/{chrome,firefox}; Snap browsers may need
the extracted copies in your home directory instead.

A local Python service binds to 127.0.0.1 on a random port. A random URL token
protects the app and storage; writes and API calls require a matching header.
The service forwards HTTPS JSON-2 and JSON-RPC requests to Odoo with normal TLS
certificate checks, without exposing API keys in URLs or server logs. No cloud
storage or external hosting is involved. Stop the service from its status window.

## Future packages
Extract the source and edit the application files, then build with:

    python3 build.py 1.2.1 ./dist

Retain the package name and payroll.json location, and keep future code compatible
with saved payroll data. Install the resulting .deb over the old version.

## Verification
Checked JavaScript/Python syntax, package contents, HTTP handler storage round
trips, blocked unauthenticated writes, and companion approval/tab-routing with mocked browser APIs, plus HTTPS transport with a mocked Odoo
connection. Loopback socket binding was blocked in the build sandbox. Graphical browser launch and live Odoo operations still require a
check on the target desktop; no Odoo account was available during development.
