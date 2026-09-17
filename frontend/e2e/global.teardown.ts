import { request } from "@playwright/test";
import { API_URL, UI_DOC_NAME, endBlockingBanners, readState } from "./helpers";

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

  // Safety net for the banner specs: a run that died between publishing a
  // blocking banner and its afterEach delete would leave the chat paused for
  // the next run and for anyone using this stack. The monitor's own incidents
  // are left alone — see endBlockingBanners.
  await endBlockingBanners(api, state.adminToken, true).catch((err) => {
    console.warn(`e2e teardown: could not clear leftover blocking banners — ${err}`);
  });

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
