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

// Very simple in-memory session store (we’ll replace/upgrade later if needed)
type SessionData = {
  createdAt: number;
  googleTokens?: any; // we'll store OAuth tokens here
};

const sessions = new Map<string, SessionData>();

function extractToolCall(body: any): { name: string; args: any } | null {
  // Handles common shapes; Vapi sends tool calls inside messages/events.
  const toolCall =
    body?.message?.toolCalls?.[0] ||
    body?.message?.tool_calls?.[0] ||
    body?.toolCall ||
    body?.tool_call;

  const name = toolCall?.function?.name || toolCall?.name;
  const rawArgs = toolCall?.function?.arguments || toolCall?.arguments;

  if (!name) return null;

  let args = rawArgs;
  if (typeof rawArgs === "string") {
    try { args = JSON.parse(rawArgs); } catch { args = {}; }
  }

  return { name, args };
}

function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getOrCreateSession(req: any, res: any) {
  let sessionId = req.cookies.sessionId as string | undefined;

  if (!sessionId) {
    sessionId = nanoid();
    const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");
    res.cookie("sessionId", sessionId, { httpOnly: true, sameSite: "lax", secure });
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { createdAt: Date.now() });
  }

  return { sessionId, session: sessions.get(sessionId)! };
}


app.get("/auth/google", (req, res) => {
  // Always ensure a session exists + is registered
  getOrCreateSession(req, res);

  const oauth2 = makeOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"]
  });

  res.redirect(url);
});

app.get("/auth/status", (req, res) => {
  const { sessionId, session } = getOrCreateSession(req, res);

  res.json({
    sessionId,
    hasSession: true,
    googleConnected: Boolean(session.googleTokens)
  });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const sessionId = req.cookies.sessionId as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).send("No session cookie. Start at /session.");
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

app.post("/vapi/webhook", async (req, res) => {
  const extracted = extractToolCall(req.body);
  if (!extracted) {
    return res.json({ ok: true, note: "No tool call found" });
  }

  // Reuse your existing tool handler logic by calling the same switch:
  req.body = { name: extracted.name, arguments: extracted.args };
  return app._router.handle(req, res, () => {});
});

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
      end: { dateTime: end.toISOString() }
    };

    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event
    });

    res.json({
      ok: true,
      eventId: result.data.id,
      htmlLink: result.data.htmlLink,
      summary: result.data.summary
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "unknown error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "voice-scheduling-agent", time: new Date().toISOString() });
});

app.get("/session", (req, res) => {
  const existing = req.cookies.sessionId as string | undefined;
  if (existing && sessions.has(existing)) {
    return res.json({ sessionId: existing });
  }

  const sessionId = nanoid();
  sessions.set(sessionId, { createdAt: Date.now() });

  // In prod (https) set secure: true. For localhost keep it false.
  const secure = (process.env.PUBLIC_BASE_URL || "").startsWith("https://");

  res.cookie("sessionId", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure
  });

  res.json({ sessionId });
});

app.post("/vapi/tool", async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: "Missing tool name" });
    }

    console.log("🔧 Tool call:", name, args);

    // We will implement handlers next
    switch (name) {
      case "create_calendar_event": {
        const { session } = getOrCreateSession(req, res);

        if (!session.googleTokens) {
            return res.status(401).json({
            ok: false,
            message: "User has not connected Google Calendar"
            });
        }

        const { attendeeName, title, startISO, endISO } = args || {};

        if (!startISO || !endISO) {
            return res.status(400).json({
            ok: false,
            message: "Missing startISO or endISO"
            });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(session.googleTokens);

        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        const event = {
            summary: title || `Meeting with ${attendeeName || "guest"}`,
            description: "Scheduled via voice agent",
            start: { dateTime: startISO },
            end: { dateTime: endISO }
        };

        const result = await calendar.events.insert({
            calendarId: "primary",
            requestBody: event
        });

        return res.json({
            ok: true,
            eventId: result.data.id,
            htmlLink: result.data.htmlLink,
            summary: result.data.summary
        });
        }

      case "check_availability":{
        const { session } = getOrCreateSession(req, res);

        if (!session.googleTokens) {
          return res.status(401).json({
            ok: false,
            message: "User has not connected Google Calendar"
          });
        }
        const { startISO, endISO } = args || {};

        if (!startISO || !endISO) {
          return res.status(400).json({
            ok: false,
            message: "Missing startISO or endISO"
          });
        }

        const oauth2 = makeOAuthClient();
        oauth2.setCredentials(session.googleTokens);

        const calendar = google.calendar({ version: "v3", auth: oauth2 });

        const fb = await calendar.freebusy.query({
          requestBody: {
            timeMin: startISO,
            timeMax: endISO,
            items: [{ id: "primary" }]
          }
        });

        const busy = fb.data.calendars?.primary?.busy || [];

        return res.json({
          ok: true,
          available: busy.length === 0,
          busySlots: busy
        });
      }

      case "suggest_alternatives": {
      const { session } = getOrCreateSession(req, res);

      if (!session.googleTokens) {
        return res.status(401).json({
          ok: false,
          message: "User has not connected Google Calendar"
        });
      }

      const { dateISO, durationMinutes } = args || {};
      const dur = Number(durationMinutes || 30);

      if (!dateISO) {
        return res.status(400).json({
          ok: false,
          message: "Missing dateISO (YYYY-MM-DD)"
        });
      }
      if (!Number.isFinite(dur) || dur <= 0) {
        return res.status(400).json({
          ok: false,
          message: "Invalid durationMinutes"
        });
      }

      const oauth2 = makeOAuthClient();
      oauth2.setCredentials(session.googleTokens);
      const calendar = google.calendar({ version: "v3", auth: oauth2 });

      // Build a set of candidate time windows in UTC for simplicity.
      // We scan 9:00–17:00, step 30 minutes.
      const suggestions: Array<{ startISO: string; endISO: string }> = [];

      // Interpret dateISO as a date, create UTC day boundaries
      const dayStart = new Date(`${dateISO}T00:00:00Z`);

      // 09:00 UTC to 17:00 UTC (simple demo; later we’ll do timezone properly)
      const startMin = 9 * 60;
      const endMin = 17 * 60;
      const step = 30;

      for (let t = startMin; t + dur <= endMin; t += step) {
        const start = new Date(dayStart.getTime() + t * 60 * 1000);
        const end = new Date(start.getTime() + dur * 60 * 1000);

        // Stop early if we already have 2 suggestions
        if (suggestions.length >= 2) break;

        const fb = await calendar.freebusy.query({
          requestBody: {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            items: [{ id: "primary" }]
          }
        });

        const busy = fb.data.calendars?.primary?.busy || [];
        if (busy.length === 0) {
          suggestions.push({ startISO: start.toISOString(), endISO: end.toISOString() });
        }
      }

      return res.json({
        ok: true,
        suggestions,
        message:
          suggestions.length > 0
            ? "Found available times."
            : "No availability found in working hours."
      });
    }

      default:
        return res.status(400).json({ error: "Unknown tool" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Tool handler error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
