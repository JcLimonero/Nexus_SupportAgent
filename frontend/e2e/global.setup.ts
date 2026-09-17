import { request } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_URL,
  UI_DOC_CONTENT,
  UI_DOC_NAME,
  UI_QUESTION,
  UI_USER_EMAIL,
  UI_USER_PASSWORD,
  chatBlockedHint,
  endBlockingBanners,
  writeState,
} from "./helpers";

export default async function globalSetup() {
  const api = await request.newContext({ baseURL: API_URL });

  const health = await api.get("/health").catch(() => null);
  if (!health || !health.ok()) {
    throw new Error(`Stack not reachable at ${API_URL} — start it with \`docker compose up -d\``);
  }

  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${await login.text()}`);
  const adminToken = (await login.json()).access_token as string;
  const auth = { Authorization: `Bearer ${adminToken}` };

  // Before anything else: a live chat-blocking banner makes the backend answer
  // 503 to every chat call, which would take the pre-warm below — and with it
  // the whole run, before a single test — down over something no spec here is
  // testing. Same guard the Python suite runs first (_clear_blocking_banners).
  const ended = await endBlockingBanners(api, adminToken);
  if (ended > 0) {
    console.warn(`e2e setup: ended ${ended} live chat-blocking banner(s) left on this stack.`);
  }

  // Knowledge doc (repeat-safe: replace any leftover copy), then wait for the
  // background indexer to publish it.
  await api.delete(`/api/admin/documents/${UI_DOC_NAME}`, { headers: auth });
  const upload = await api.post("/api/admin/upload", {
    headers: auth,
    multipart: {
      file: { name: UI_DOC_NAME, mimeType: "text/plain", buffer: Buffer.from(UI_DOC_CONTENT) },
    },
  });
  if (!upload.ok()) throw new Error(`doc upload failed: ${await upload.text()}`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const docs = (await (await api.get("/api/admin/documents", { headers: auth })).json()) as { file_name: string }[];
    if (docs.some((d) => d.file_name === UI_DOC_NAME)) break;
    if (Date.now() > deadline) throw new Error(`${UI_DOC_NAME} not indexed in 120s`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Dedicated UI user (repeat-safe).
  const users = (await (await api.get("/api/users", { headers: auth })).json()) as { id: string; email: string }[];
  const leftover = users.find((u) => u.email === UI_USER_EMAIL);
  if (leftover) await api.delete(`/api/users/${leftover.id}`, { headers: auth });
  const created = await api.post("/api/users", {
    headers: auth,
    data: { email: UI_USER_EMAIL, password: UI_USER_PASSWORD, is_admin: false },
  });
  if (!created.ok()) throw new Error(`user create failed: ${await created.text()}`);
  const uiUserId = (await created.json()).id as string;
  const uiLogin = await api.post("/api/auth/login", {
    data: { email: UI_USER_EMAIL, password: UI_USER_PASSWORD },
  });
  const uiToken = (await uiLogin.json()).access_token as string;

  // Pre-warm the semantic cache with the suite's question (one real LLM call)
  // so every browser interaction afterwards is an instant cache hit.
  const warm = await api.post("/api/chat/stream", {
    headers: { Authorization: `Bearer ${uiToken}` },
    data: { message: UI_QUESTION },
    timeout: 120_000,
  });
  // A 503 here means a banner went live between the cleanup above and now —
  // the self-monitor opening its own after ~3 failed checks. Don't fight that
  // (the stack really is broken at that point), just say where to look.
  if (!warm.ok()) {
    throw new Error(`cache pre-warm failed: ${warm.status()}${chatBlockedHint(warm.status())}`);
  }
  await warm.text();

  writeState({ adminToken, uiToken, uiUserId });
  await api.dispose();
}
