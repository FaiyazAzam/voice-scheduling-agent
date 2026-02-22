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
// Types + In-memory sessions
// -----------------------------
type SessionData = {
  createdAt: number;
  googleTokens?: any; // OAuth tokens
};

const sessions = new Map<string, SessionData>();

// -----------------------------
// Helpers
// -----------------------------
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

function getSessionFromReqOrArgs(req: any, res: any, args: any) {
  // 1) Browser calls: cookie session
  const cookieSid = req.cookies?.sessionId as string | undefined;

  // 2) Vapi tool calls: pass sessionId explicitly in tool arguments
  const argSid = (args?.sessionId as string | undefined) || undefined;

  const sessionId = cookieSid || argSid;

  if (!sessionId) {
    // If there is no cookie, we won't create a new session automatically here,
    // because tool calls should use an existing connected sessionId.
    return { sessionId: null as string | null, session: null as SessionData | null };
  }

  // If cookieSid exists but session got wiped (restart), recreate minimal session container
  if (!sessions.has(sessionId)) {
    // Only recreate if it came from cookies; for argSid we expect it to exist
    if (cookieSid) sessions.set(sessionId, { createdAt: Date.now() });
    else return { sessionId, session: null as SessionData | null };
  }

  return { sessionId, session: sessions.get(sessionId)! };
}

function extractToolNameAndArgs(body: any): { name: string | null; args: any } {
  // Your curl format: { name, arguments }
  if (body?.name) return { name: body.name, args: body.arguments || {} };

  // Common Vapi formats (varies by tool type / webhook flavor)
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

// Vapi expects a tool result payload; safest universal wrapper:
function vapiResult(res: any, payload: any) {
  return res.json({ result: payload });
}

function vapiError(res: any, status: number, payload: any) {
  return res.status(status).json({ result: payload });
}

// Optional: request logging (helps debugging on Railway)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// -----------------------------
// Routes: Health + Landing
// -----------------------------
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voice Scheduling Agent Backend ✅</h2>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/auth/google">/auth/google</a></li>
      <li><a href="/auth/status">/auth/status</a></li>
    </ul>
  `);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "voice-scheduling-agent", time: new Date().toISOString() });
});

// -----------------------------
// OAuth: Google Calendar
// -----------------------------
app.get("/auth/google", (req, res) => {
  // Ensure a session exists for the browser
  getOrCreateSession(req, res);

  const oauth2 = makeOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
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
    const sessionId = req.cookies?.sessionId as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).send("No session cookie. Start at /auth/google.");
    }
    if (!code) {
      return res.status(400).send("Missing code.");
    }

    const oauth2 = makeOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    const session = sessions.get(sessionId)!;
    session.googleTokens = tokens;
    sessions.set(sessionId, session);

    res.type("html").send(`
      <h2>Google Calendar connected ✅</h2>
      <p>You can close this tab now.</p>
    `);
  } catch (e: any) {
    res.status(500).send(`OAuth error: ${e?.message || "unknown error"}`);
  }
});

// Kept for compatibility with your earlier flow
app.get("/session", (req, res) => {
  const existing = req.cookies?.sessionId as string | undefined;
  if (existing && sessions.has(existing)) {
    return res.json({ sessionId: existing });
  }

  const sessionId = nanoid();
  sessions.set(sessionId, { createdAt: Date.now() });

  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");

  res.cookie("sessionId", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure,
  });

  res.json({ sessionId });
});

// -----------------------------
// Debug: create an event (browser cookie session only)
// -----------------------------
app.get("/debug/create-event", async (req, res) => {
  try {
    const { session } = getOrCreateSession(req, res);

    if (!session.googleTokens) {
      return res.status(401).send("Not connected. Go to /auth/google first.");
    }

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
// Vapi Tool Endpoint
// -----------------------------
app.post("/vapi/tool", async (req, res) => {
  try {
    const { name, args } = extractToolNameAndArgs(req.body);

    if (!name) {
      console.log("Bad tool payload:", JSON.stringify(req.body));
      return vapiError(res, 400, { ok: false, error: "Missing tool name" });
    }

    console.log("🔧 Tool call:", name, args);
    console.log("Incoming cookies:", req.headers.cookie || "(none)");

    switch (name) {
      case "create_calendar_event": {
        const { sessionId, session } = getSessionFromReqOrArgs(req, res, args);

        if (!session?.googleTokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "User has not connected Google Calendar",
            sessionId,
          });
        }

        const { attendeeName, title, startISO, endISO } = args || {};

        if (!startISO || !endISO) {
          return vapiError(res, 400, { ok: false, message: "Missing startISO or endISO" });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(session.googleTokens);

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

      case "check_availability": {
        const { sessionId, session } = getSessionFromReqOrArgs(req, res, args);

        if (!session?.googleTokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "User has not connected Google Calendar",
            sessionId,
          });
        }

        const { startISO, endISO } = args || {};
        if (!startISO || !endISO) {
          return vapiError(res, 400, { ok: false, message: "Missing startISO or endISO" });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(session.googleTokens);

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
        const { sessionId, session } = getSessionFromReqOrArgs(req, res, args);

        if (!session?.googleTokens) {
          return vapiError(res, 401, {
            ok: false,
            message: "User has not connected Google Calendar",
            sessionId,
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
        oauth2.setCredentials(session.googleTokens);
        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        // Demo scan: 09:00–17:00 UTC, step 30 minutes. (Later: timezone-aware)
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
          message:
            suggestions.length > 0 ? "Found available times." : "No availability found in working hours.",
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