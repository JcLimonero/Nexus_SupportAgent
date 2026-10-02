# Rotating the Gemini service-account key

The prod backend authenticates to Vertex AI with a JSON key for
`nexus-onprem@nexus-support-agent.iam.gserviceaccount.com`, mounted from
`gcp-credentials.json` at the repo root **on the prod server only**. GCP keys
don't expire on their own, so the limit is ours: **90 days**, tracked in
`ops/credentials.json`. A weekly GitHub Actions job (`credential-expiry`) goes
red and opens an issue 14 days before, and `deploy-prod.ps1` warns on every
deploy. Check by hand with `.\scripts\check-credential-age.ps1`.

The server has no `gcloud`, so the key is created on a machine that has it, moved
over RDP, and the local copy deleted. The service account only has
`roles/aiplatform.user`, so a leaked key can call Gemini on our bill and nothing else.

Local dev does **not** use this key: `docker-compose.yml` mounts your own gcloud
login (`gcloud auth application-default login`).

## Steps

1. **Create the new key** (the old one keeps working), outside the repo:
   ```
   gcloud iam service-accounts keys create <temp-folder>\gcp-credentials.new.json `
     --iam-account nexus-onprem@nexus-support-agent.iam.gserviceaccount.com --project nexus-support-agent
   ```
2. **Copy it to the server over RDP** (drive redirection or paste; never email or chat).
3. **On the server**, in the repo checkout (`C:\inetpub\Nexus_SupportAgent`):
   ```
   Copy-Item gcp-credentials.json gcp-credentials.old.json
   Copy-Item <where-you-pasted>\gcp-credentials.new.json gcp-credentials.json -Force
   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
   ```
   A plain restart is not enough: a replaced single-file bind mount keeps the old file.
   Do it off-hours; chat is down for the ~1 min the backend takes to load its models.
   If the log shows `c10::Error ... getCount is non-monotonic`, that is a flaky
   PyTorch start on the RAM-starved host, not the key: restart again.
4. **Verify**: `curl.exe -s http://127.0.0.1:<NGINX_HOST_PORT>/health`, ask one real
   question in the chat, and check `/admin/avisos` shows no Gemini banner.
5. **Delete the old key** in GCP (list the user-managed keys first; keep the new one):
   ```
   gcloud iam service-accounts keys list --iam-account nexus-onprem@nexus-support-agent.iam.gserviceaccount.com --managed-by=user
   gcloud iam service-accounts keys delete <OLD_KEY_ID> --iam-account nexus-onprem@nexus-support-agent.iam.gserviceaccount.com
   ```
6. **Clean up**: delete `gcp-credentials.new.json` and `gcp-credentials.old.json` on the
   server and your temp copy on the machine that created it.
7. **Reset the clock**: set `created` (today) and `key_id` (the new id) in
   `ops/credentials.json`, then commit on a branch and open a PR.

Rollback before step 5: put `gcp-credentials.old.json` back and repeat the recreate.
