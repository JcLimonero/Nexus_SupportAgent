# Migración a Coolify

Estado a mover: volumen `pgdata` (Postgres), volumen `nexus_data` (PDFs/MP4), `.env` y `gcp-credentials.json`. Todo lo demás sale de git.

Archivos: `docker-compose.coolify.yml`, `scripts/migrate/backup-for-migration.ps1`, `scripts/migrate/restore-coolify.sh`.

## Reglas que no se rompen

- **Mismo `JWT_SECRET`** que en prod. Firma sesiones y URLs de media; si cambia, todos tienen que volver a iniciar sesión.
- **Mismo `DB_PASSWORD` no es necesario** (el restore usa el del stack nuevo), pero `EMBEDDING_DIMENSIONS=384` y la imagen `pgvector/pgvector:0.8.2-pg16` sí.
- **No re-indexar.** Los embeddings viajan dentro del dump.
- El servidor viejo se queda **apagado pero intacto** 1–2 semanas (rollback).

## Preparación (una vez)

1. En el servidor Coolify crea `/opt/nexus/gcp-credentials.json` (el mismo archivo de prod, `chmod 600`). Otra ruta: variable `GCP_CREDENTIALS_HOST_PATH`.
2. Coolify → New Resource → Docker Compose → repo, rama `main` (tras mergear), archivo `docker-compose.coolify.yml`.
3. Variables (copiar de `.env` de prod): `DB_PASSWORD`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `VERTEX_AI_PROJECT`, `VERTEX_AI_LOCATION`, `ALLOW_ANONYMOUS`, `EMAILJS_*`, `ESCALATION_NOTIFY_EMAIL`, `MIN_FREE_DISK_MB`, `ATTACHMENT_RETENTION_DAYS`.
4. `PUBLIC_ORIGIN=https://soporte.nexusqtech.com` marcada también como **Build Variable** (se hornea en el frontend; si luego cambia el dominio hay que reconstruir, no reiniciar).
5. Dominio en el servicio **nginx**: `https://soporte.nexusqtech.com:80`. Sin puerto en la URL pública.
6. DNS: registro **A** `soporte.nexusqtech.com` → `74.208.151.19` (servidor Coolify). Traefik emite el certificado cuando resuelve. No hay comodín en `nexusqtech.com`, así que el registro hay que crearlo.

### Dominio
El dominio definitivo es `soporte.nexusqtech.com` (elegido 2026-10-03). Sigue el patrón de las otras apps en Coolify (`crm.`, `support.` ya está ocupado por GLPI Nexus). Como es un nombre nuevo, distinto de `app-nexusqtech.com`, **el ensayo se hace ya con el dominio final**: el viejo sigue sirviendo en su dominio y no hace falta reconstruir el frontend en el corte.

Los enlaces viejos (`app-nexusqtech.com`) dejan de funcionar al apagar el servidor viejo. Avisar a los usuarios del dominio nuevo y actualizar marcadores y correos.

## Ensayo (el viejo sigue sirviendo)

1. En el servidor viejo: `.\scripts\migrate\backup-for-migration.ps1`
2. Copia la carpeta resultante al servidor Coolify.
3. Despliega en Coolify y espera a que `db` y `backend` estén healthy.
4. `./scripts/migrate/restore-coolify.sh <carpeta>` — debe terminar en `RESTORE VERIFIED`.
5. Prueba: login admin, chat con streaming (tokens llegan en vivo), abrir un PDF y un video citados, `/admin/avisos`, y
   `docker exec <backend> python rag_eval.py` (debe dar lo mismo que en prod).

## Corte

1. Banner `blocks_chat` en `/admin/avisos` del viejo (o simplemente avisar: no suban documentos).
2. Backup final + restore (mismos pasos del ensayo).
3. Verificar, avisar del dominio nuevo (`soporte.nexusqtech.com`; el DNS ya apunta a Coolify desde el ensayo), apagar el stack viejo (`docker compose -f docker-compose.prod.yml stop`, **nunca `down -v`**).
4. Actualizar en EmailJS/correos cualquier link con el dominio viejo (`share_link` usa `PUBLIC_ORIGIN`).

## Después

- Programar backups: Coolify → Scheduled Tasks (pg_dump) o backups nativos a S3; los PDFs/MP4 aparte.
- Rotar la key de Gemini (`ops/ROTATE_GCP_KEY.md`) ya que el archivo se copió.
- Límites que Traefik no replica: HSTS (agregarlo en Coolify o nginx si se quiere).
- `deploy-prod.ps1` e `iis/` quedan obsoletos; borrarlos cuando el viejo se dé de baja.

## Probado en local (2026-10-03)

Se levantó `docker-compose.coolify.yml` dos veces (origen y destino, con distinto `DB_PASSWORD`), se sembró un documento real (2 chunks con embeddings), una sesión con mensajes con acentos y un archivo en `/data`, y se corrió backup → restore. Resultado: conteos iguales en las 8 tablas, hash idéntico de embeddings+contenido, archivo idéntico, y un JWT emitido en el origen fue aceptado por el destino. Por nginx: `/health` 200, `/api/status` 200, `/docs` 404, headers de seguridad presentes.

Notas:
- Si pruebas el restore desde **Git Bash en Windows**, exporta `MSYS_NO_PATHCONV=1` (reescribe las rutas `/tmp`). En el servidor Linux no aplica.
- Con credenciales de Gemini inválidas, el monitor abre un banner `blocks_chat` solo a los ~3 min y viaja en el dump. Si el destino arranca con el banner, termínalo en `/admin/avisos` después de comprobar la key.
- No probado aquí: Traefik/TLS reales y el streaming SSE a través de Traefik (no hay Coolify local). Verifícalo en el ensayo.
