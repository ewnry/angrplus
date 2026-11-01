if (!process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || !process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET) {
  console.warn('\n[Antigravity+] OAuth credentials are not bundled with the source.');
  console.warn('Set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET before running the application.');
  console.warn('Google account login and token refresh require valid credentials.\n');
}
