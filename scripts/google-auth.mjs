#!/usr/bin/env node
// One-time helper to obtain a Google OAuth refresh token for Google Tasks.
//
// Usage:
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run auth
//
// It opens a browser, you approve access to Google Tasks for the target account,
// and it prints a GOOGLE_REFRESH_TOKEN to paste into your Vercel env vars.
//
// Make sure the OAuth consent screen is published ("In production", or User Type
// "Internal" for a Workspace account) so the refresh token does NOT expire.

import http from "node:http";
import { exec } from "node:child_process";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/tasks";

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running.");
  console.error("Example: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run auth");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
  });

async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  return json;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<h2>Authorization failed: ${error}</h2>`);
    console.error("Authorization failed:", error);
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchangeCode(url.searchParams.get("code"));
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<h2>Done. You can close this tab and return to the terminal.</h2>");

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token was returned. This usually means you've authorized before.\n" +
          "Revoke access at https://myaccount.google.com/permissions and run `npm run auth` again.",
      );
      process.exit(1);
    }

    console.log("\n Success. Add this to your Vercel environment variables:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html" }).end(`<h2>${e.message}</h2>`);
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nListening on ${REDIRECT_URI}`);
  console.log("Opening your browser to authorize Google Tasks access...");
  console.log("If it doesn't open, visit this URL manually:\n");
  console.log(authUrl + "\n");
  const platform = process.platform;
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`, () => {});
});
