import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 8080);

// -----------------------------
// Types + In-memory stores
// -----------------------------
type SessionData = {
  createdAt: number;
  googleTokens?: any; // OAuth tokens (cookie-session flow)
};

type ConnectSession = {
  createdAt: number;
  expiresAt: number;
  googleTokens?: any; // OAuth tokens (connectToken flow)
};

const sessions = new Map<string, SessionData>();
const connectSessions = new Map<string, ConnectSession>();

// -----------------------------
// Helpers
// -----------------------------
function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getOrCreateSession(req: any, res: any) {
  let sessionId = req.cookies?.sessionId as string | undefined;

  if (!sessionId) {
    sessionId = nanoid();
    const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure,
    });
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { createdAt: Date.now() });
  }

  return { sessionId, session: sessions.get(sessionId)! };
}

function newConnectToken() {
  return nanoid(24);
}

function getConnectSession(token: string | undefined) {
  if (!token) return null;
  const s = connectSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    connectSessions.delete(token);
    return null;
  }
  return s;
}

function extractToolNameAndArgs(body: any): { name: string | null; args: any } {
  // Your curl format: { name, arguments }
  if (body?.name) return { name: body.name, args: body.arguments || {} };

  // Common Vapi formats (varies by webhook flavor)
  const tc =
    body?.message?.toolCalls?.[0] ||
    body?.message?.tool_calls?.[0] ||
    body?.toolCall ||
    body?.tool_call ||
    body?.tool;

  const name = tc?.function?.name || tc?.name || body?.toolName || null;

  let args = tc?.function?.arguments ?? tc?.arguments ?? body?.toolArguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }

  return { name, args };
}

// Vapi-compatible result wrapper
function vapiResult(res: any, payload: any) {
  return res.json({ result: payload });
}
function vapiError(res: any, status: number, payload: any) {
  return res.status(status).json({ result: payload });
}

// Choose tokens from connectToken first, then cookie-session fallback
function resolveGoogleTokens(req: any, res: any, args: any): { tokens: any | null; source: string } {
  const connectToken = (args?.connectToken as string | undefined) || undefined;
  const cs = getConnectSession(connectToken);

  if (cs?.googleTokens) return { tokens: cs.googleTokens, source: "connectToken" };

  // fallback for browser/manual testing
  const { session } = getOrCreateSession(req, res);
  if (session?.googleTokens) return { tokens: session.googleTokens, source: "cookieSession" };

  return { tokens: null, source: "none" };
}

// Optional request logging (helps debugging on Railway)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// -----------------------------
// Routes: Landing + Health
// -----------------------------
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voice Scheduling Agent Backend ✅</h2>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/connect">/connect</a> (Vapi web-call calendar connect)</li>
      <li><a href="/auth/google">/auth/google</a> (cookie-session connect)</li>
      <li><a href="/auth/status">/auth/status</a></li>
    </ul>
  `);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "voice-scheduling-agent", time: new Date().toISOString() });
});

// -----------------------------
// Connect flow (proper for Vapi web calls)
// -----------------------------
app.get("/connect", (_req, res) => {
  const connectToken = newConnectToken();
  connectSessions.set(connectToken, {
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  const link = `${publicBaseUrl()}/auth/google?connectToken=${encodeURIComponent(connectToken)}`;

  res.type("html").send(`
    <h2>Connect Google Calendar</h2>
    <p>Click below to connect your Google Calendar.</p>
    <p><a href="${link}">Connect Google Calendar</a></p>
    <p>After connecting, return to your Vapi call.</p>
    <hr/>
    <p><b>connectToken:</b> ${connectToken}</p>
    <p><small>This token expires in ~10 minutes.</small></p>
  `);
});

// -----------------------------
// OAuth: Google Calendar
// -----------------------------
app.get("/auth/google", (req, res) => {
  const connectToken = String(req.query.connectToken || "");

  // If using connect flow, ensure token exists
  if (connectToken) {
    const cs = getConnectSession(connectToken);
    if (!cs) return res.status(400).send("Invalid or expired connectToken. Start again at /connect.");
  } else {
    // cookie-session flow fallback
    getOrCreateSession(req, res);
  }

  const oauth2 = makeOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: connectToken ? `connect:${connectToken}` : undefined,
  });

  res.redirect(url);
});

app.get("/auth/status", (req, res) => {
  const { sessionId, session } = getOrCreateSession(req, res);

  res.json({
    sessionId,
    hasSession: true,
    googleConnected: Boolean(session.googleTokens),
  });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code.");

    const oauth2 = makeOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    const state = String(req.query.state || "");

    // Connect-token flow (for Vapi web calls)
    if (state.startsWith("connect:")) {
      const connectToken = state.replace("connect:", "");
      const cs = getConnectSession(connectToken);
      if (!cs) return res.status(400).send("Connect session expired. Start again at /connect.");

      cs.googleTokens = tokens;
      connectSessions.set(connectToken, cs);

      return res.type("html").send(`
        <h2>Google Calendar connected ✅</h2>
        <p>Return to your Vapi call now.</p>
        <hr/>
        <p><b>connectToken:</b> ${connectToken}</p>
      `);
    }

    // Cookie-session flow fallback
    const sessionId = req.cookies?.sessionId as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).send("No session cookie. Start at /auth/google.");
    }

    const session = sessions.get(sessionId)!;
    session.googleTokens = tokens;
    sessions.set(sessionId, session);

    return res.type("html").send(`
      <h2>Google Calendar connected ✅</h2>
      <p>You can close this tab now.</p>
    `);
  } catch (e: any) {
    res.status(500).send(`OAuth error: ${e?.message || "unknown error"}`);
  }
});

// Kept for compatibility with earlier flow
app.get("/session", (req, res) => {
  const existing = req.cookies?.sessionId as string | undefined;
  if (existing && sessions.has(existing)) return res.json({ sessionId: existing });

  const sessionId = nanoid();
  sessions.set(sessionId, { createdAt: Date.now() });

  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
  res.cookie("sessionId", sessionId, { httpOnly: true, sameSite: "lax", secure });

  res.json({ sessionId });
});

// -----------------------------
// Debug: create an event (browser cookie session only)
// -----------------------------
app.get("/debug/create-event", async (req, res) => {
  try {
    const { session } = getOrCreateSession(req, res);
    if (!session.googleTokens) return res.status(401).send("Not connected. Go to /auth/google first.");

    const oauth2 = makeOAuthClient();
    oauth2.setCredentials(session.googleTokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2 });

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Voice Agent Test Event",
      description: "Created from /debug/create-event endpoint",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
    });

    res.json({
      ok: true,
      eventId: result.data.id,
      htmlLink: result.data.htmlLink,
      summary: result.data.summary,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown error" });
  }
});

// -----------------------------
// Vapi Tool Endpoint (works with Vapi payloads + curl payloads)
// -----------------------------
app.post("/vapi/tool", async (req, res) => {
  try {
    const { name, args } = extractToolNameAndArgs(req.body);

    if (!name) {
      console.log("Bad tool payload:", JSON.stringify(req.body));
      return vapiError(res, 400, { ok: false, error: "Missing tool name" });
    }

    console.log("🔧 Tool call:", name, args);

    switch (name) {
      case "check_availability": {
        const { tokens, source } = resolveGoogleTokens(req, res, args);
        if (!tokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "Not connected. Open /connect and complete Google OAuth first.",
            source,
          });
        }

        const { startISO, endISO } = args || {};
        if (!startISO || !endISO) {
          return vapiError(res, 400, { ok: false, message: "Missing startISO or endISO" });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        const fb = await calendar.freebusy.query({
          requestBody: {
            timeMin: startISO,
            timeMax: endISO,
            items: [{ id: "primary" }],
          },
        });

        const busy = fb.data.calendars?.primary?.busy || [];
        return vapiResult(res, { ok: true, available: busy.length === 0, busySlots: busy });
      }

      case "suggest_alternatives": {
        const { tokens, source } = resolveGoogleTokens(req, res, args);
        if (!tokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "Not connected. Open /connect and complete Google OAuth first.",
            source,
          });
        }

        const { dateISO, durationMinutes } = args || {};
        const dur = Number(durationMinutes || 30);

        if (!dateISO) {
          return vapiError(res, 400, { ok: false, message: "Missing dateISO (YYYY-MM-DD)" });
        }
        if (!Number.isFinite(dur) || dur <= 0) {
          return vapiError(res, 400, { ok: false, message: "Invalid durationMinutes" });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        // Demo scan: 09:00–17:00 UTC, step 30 minutes (simple + deterministic)
        const suggestions: Array<{ startISO: string; endISO: string }> = [];
        const dayStart = new Date(`${dateISO}T00:00:00Z`);

        const startMin = 9 * 60;
        const endMin = 17 * 60;
        const step = 30;

        for (let t = startMin; t + dur <= endMin; t += step) {
          if (suggestions.length >= 2) break;

          const start = new Date(dayStart.getTime() + t * 60 * 1000);
          const end = new Date(start.getTime() + dur * 60 * 1000);

          const fb = await calendar.freebusy.query({
            requestBody: {
              timeMin: start.toISOString(),
              timeMax: end.toISOString(),
              items: [{ id: "primary" }],
            },
          });

          const busy = fb.data.calendars?.primary?.busy || [];
          if (busy.length === 0) {
            suggestions.push({ startISO: start.toISOString(), endISO: end.toISOString() });
          }
        }

        return vapiResult(res, {
          ok: true,
          suggestions,
          message: suggestions.length > 0 ? "Found available times." : "No availability found in working hours.",
        });
      }

      case "create_calendar_event": {
        const { tokens, source } = resolveGoogleTokens(req, res, args);
        if (!tokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "Not connected. Open /connect and complete Google OAuth first.",
            source,
          });
        }

        const { attendeeName, title, startISO, endISO } = args || {};
        if (!startISO || !endISO) {
          return vapiError(res, 400, { ok: false, message: "Missing startISO or endISO" });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        const event = {
          summary: title || `Meeting with ${attendeeName || "guest"}`,
          description: "Scheduled via voice agent",
          start: { dateTime: startISO },
          end: { dateTime: endISO },
        };

        const result = await calendar.events.insert({
          calendarId: "primary",
          requestBody: event,
        });

        return vapiResult(res, {
          ok: true,
          eventId: result.data.id,
          htmlLink: result.data.htmlLink,
          summary: result.data.summary,
        });
      }

      default:
        return vapiError(res, 400, { ok: false, error: "Unknown tool", name });
    }
  } catch (e: any) {
    console.error("Tool handler error:", e);
    return vapiError(res, 500, { ok: false, error: e?.message || "Tool handler error" });
  }
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});