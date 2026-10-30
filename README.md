# Payroll Helper

Odoo payroll helper for **Ubuntu 22.04 and later**. Choose Chrome, Brave, Firefox
or Chromium at launch. Payroll data is stored on disk independently of browsers
and retained across package updates.

## Project status
The desktop app and logged-in-tab companions are implemented. The installer,
GitHub release workflow and automatic Chrome/Brave policy deployment are prepared.
**A stable all-browser release is pending Mozilla signing of the Firefox add-on
and target-desktop testing.** This repository does not bypass Firefox signing.

## Install and update
Once a stable GitHub release has been published, use:

```bash
curl -fsSL https://raw.githubusercontent.com/harnik-jammarh/payroll-helper/main/install.sh | bash
```

The same command installs newer releases over existing versions. Release selection
uses small channel files hosted in this repository, avoiding GitHub API rate limits. It requires
administrator access, installs Python/Tk dependencies through apt, and configures
system-wide companion policies. It does not install browsers themselves.
The checksum file detects download corruption; it is hosted with the release and
is not an independent authenticity signature. Only install releases you trust.

For the current preview (automatic Chrome/Brave setup; Firefox signing pending):

```bash
curl -fsSL https://raw.githubusercontent.com/harnik-jammarh/payroll-helper/main/install.sh | bash -s -- --preview
```

Alternatively download a preview `.deb` from Releases or build:

```bash
python3 build.py 1.3.0 dist
sudo apt install ./dist/odoo-payroll-helper_1.3.0_all.deb
odoo-payroll-helper
```

A plain build includes companion sources but does not configure automatic browser
installation. Full deployment builds use `scripts/release.py`, described below.

## Browsers and logged-in tabs
API-key mode works without a browser companion. Logged-in-tab mode requires the
companion in the **same browser and profile** as Odoo. The app finds matching tabs
by the HTTPS Odoo URL and prefers an active matching tab. Click the companion
icon on the payroll page to approve access to that page, then choose logged-in-tab
mode and Connect. Site session cookies are used inside Odoo and are not copied.

Deployment builds automatically configure the companion for native Chrome and
Brave using Linux browser policies. A signed Firefox XPI enables equivalent
Firefox policy configuration, including the system policy path used by Ubuntu's
Firefox Snap. Restart browsers after installation. Existing administrator policies
can take precedence; inspect `chrome://policy`, `brave://policy`, or `about:policies`.
Managed browser policies may display “Managed by your organization”.
Chromium, Flatpak browsers and alternative browser packaging are not yet covered
by automatic policy deployment; manual extension installation remains available.
Firefox compatibility and automatic deployment require testing on Ubuntu's Snap.

## Data

`~/.local/share/odoo-payroll-helper/payroll.json` holds payroll settings and data;
`payroll.previous.json` holds the previous save. Private files include the API key.
The app uses atomic saves and user-only file permissions. Package installation,
upgrades and removal never delete user payroll files. Old extension profiles are
left untouched; import a JSON backup to migrate from the original extension.
Keep the small application status window open while using the browser page.

## Build releases

Prerequisites: Python 3, Node.js (tests), OpenSSL and dpkg-deb. Run from repository root:

```bash
python3 tests/desktop.py
node tests/companion.cjs
python3 tests/packaging.py
python3 scripts/release.py 1.3.0 --key .private/chromium.pem \
  --firefox-xpi-url https://your-signed-addon-url.example/companion.xpi \
  --require-companions
```

Keep the same Chromium private key for every release. Never commit it. Configure
it as the GitHub Actions repository secret `CRX_PRIVATE_KEY`. CRX3 and the update
manifest are self-hosted using GitHub Release assets; no Chrome Web Store account
is needed for this Linux policy deployment.

For Firefox, submit the companion for Mozilla signing as an unlisted add-on using
ID `payroll-tab-companion@local.odoo-helper`. Set repository Actions variable
`FIREFOX_SIGNED_XPI_URL` to the signed XPI for the exact release version. The build
checks ID, version and signature-file presence; Firefox validates the signature.
The maintainer must update the signed add-on URL for each version.

Run **Actions → Release** with an increasing version. It runs tests, builds a
universal `all.deb`, CRX3, update XML, companion ZIPs, and SHA256SUMS. The default
requires all companions; missing Firefox signing stops the release before
publication. Turning that requirement off explicitly publishes a **prerelease**,
which the stable installer does not pick up. Stable releases become available to
the one-command installer automatically. Do not replace release assets in place:
publish increasing versions instead.

## Policy lifecycle
The package post-install hook configures only our extension ID entries under:

- `/etc/opt/chrome/policies/managed/odoo-payroll-helper.json`
- `/etc/brave/policies/managed/odoo-payroll-helper.json`
- `/etc/firefox/policies/policies.json`

Other entries are preserved. Package removal restores previous values when our
installed values have not been edited by an administrator. Policy tracking is in
`/var/lib/odoo-payroll-helper/policy-state.json`. Browsers may retain a previously
installed extension after policy removal; disable/remove it normally if desired.

## Verification and limits
CI targets Ubuntu 22.04 and 24.04. Tests cover storage, origin/token checks,
companion routing, policy upgrade/removal, and independently verify CRX3 signatures.
Live Odoo operations, real browser policy deployment and the Firefox Snap path
have not yet been verified on a desktop. Ubuntu versions after 24.04 are targeted
by the installer, but are not claimed as tested.

See [the user guide](docs/USER_GUIDE.md) for manual companion installation.
No software license has been selected; choose a license before accepting reuse or
third-party contributions.
