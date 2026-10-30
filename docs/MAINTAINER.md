# Remaining release setup

1. Keep the generated Chromium signing key private and backed up. The GitHub
   Actions secret must contain its PEM text; changing it changes the extension ID.
2. Sign the Firefox extension through Mozilla's unlisted add-on distribution
   process. The unsigned source is in companion/ and the ZIP is a release artifact.
3. Set FIREFOX_SIGNED_XPI_URL to an HTTPS URL for the signed, matching version.
4. Test installing/removing the deployment .deb on Ubuntu 22.04 and 24.04 desktops
   with Chrome, Brave and Ubuntu's default Firefox Snap. Confirm companion policies,
   signed installs, approvals, tab detection and data persistence on upgrades.
5. Publish the stable release only after those checks. Prereleases intentionally do
   not power the public one-command installer.

Primary references:
- https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux
- https://support.google.com/chrome/a/answer/9047197
- https://support.brave.app/hc/en-us/articles/360039248271-Group-Policy
- https://mozilla.github.io/policy-templates/#extensionsettings
- https://support.mozilla.org/en-US/kb/customizing-firefox-using-policiesjson
- https://support.mozilla.org/en-US/kb/add-on-signing-in-firefox
