import { request } from "@playwright/test";
import { API_URL, UI_DOC_NAME, readState } from "./helpers";

export default async function globalTeardown() {
  let state;
  try {
    state = readState();
  } catch {
    return; // setup never completed — nothing to clean
  }
  const api = await request.newContext({ baseURL: API_URL });
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  await api.delete(`/api/admin/documents/${UI_DOC_NAME}`, { headers: auth });

  // The UI user's conversations, then the account itself.
  const convs = (await (
    await api.get(`/api/admin/conversations?user_id=${state.uiUserId}`, { headers: auth })
  ).json()) as { id: string }[];
  for (const c of convs) {
    await api.delete(`/api/admin/conversations/${c.id}`, { headers: auth });
  }
  await api.delete(`/api/users/${state.uiUserId}`, { headers: auth });

  await api.dispose();
}
