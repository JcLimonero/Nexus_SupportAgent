# Nexus Support Agent — Análisis de costos

> Fecha del análisis: **14 de julio de 2026**.
> **Todos los cálculos usan \$18.50 MXN por USD (presupuesto con colchón).**
> El tipo de cambio real al día del análisis es ~\$17.80 (El Universal / Banxico),
> por lo que los costos reales serían ~4% menores a lo aquí presupuestado.
>
> **Base de precios:** endpoint **regional us-central1** de Vertex AI, que es el que
> este proyecto usa en su configuración real (10% más caro que el endpoint global).
>
> **IVA:** los totales marcados "con IVA" incluyen el **16%** que Google, Amazon,
> Microsoft y demás proveedores facturan en México. Para una empresa este IVA es
> normalmente **acreditable** (se recupera contra el IVA cobrado), así que el costo
> financiero real suele ser el subtotal.

---

## 📌 Presupuesto de arranque (escenario a validar)

**Supuestos: 120 usuarios · 10 preguntas/día cada uno · 26 días laborales = 31,200 preguntas/mes · VPS IONOS XL+ · Gemini 3.5 Flash**

| Concepto | MXN/mes (sin IVA) |
|---|---|
| IA — Gemini 3.5 Flash (31,200 preguntas × \$0.28) | ~\$8,740 |
| Hosting — VPS IONOS XL+ (8 núcleos / 16 GB / 480 GB) | ~\$815 |
| Seguridad — Cloudflare Free | \$0 |
| Respaldo externo diario (recomendado) | ~\$40 |
| **Subtotal** | **~\$9,595** |
| IVA (16%, acreditable) | ~\$1,535 |
| **TOTAL mensual** | **~\$11,130 MXN** |
| **Costo por usuario** | **~\$93 MXN/mes** |

> Este es el presupuesto **techo**: no descuenta el caché semántico. Con la tasa
> típica de preguntas repetidas (20–40%), el total real esperado es de
> **~\$7,100–9,100 MXN/mes**. Tras el primer mes de uso real conviene comparar la
> factura contra esta tabla y recalibrar (ver sección 11).

---

## 1. Resumen ejecutivo

**Escenario de arranque real: 100–150 usuarios en VPS IONOS** (plan XL+, 8 núcleos /
16 GB RAM / 480 GB NVMe, ~\$815 MXN/mes):

| Escenario (totales con IVA) | 100–150 usuarios · VPS IONOS |
|---|---|
| Uso ligero (3–5 preguntas/día por usuario) | **~\$5,170 MXN/mes** (~\$41/usuario) |
| **Uso mixto realista** (80% ligero + 20% intensivo) | **~\$8,550 MXN/mes** (~\$68/usuario) |
| Techo: todos intensivos (20 preguntas/día) | ~\$22,060 MXN/mes (~\$176/usuario) |

Escenario de referencia menor, útil como comparación (**20 usuarios**):

| Escenario | Servidor Windows actual (on-prem) | Nube (GCP Cloud Run) |
|---|---|---|
| Uso ligero (3–5 preguntas/día por usuario) | **~\$680 MXN/mes** con IVA | ~\$1,920 MXN/mes con IVA |
| Uso intensivo (20 preguntas/día por usuario) | **~\$3,380 MXN/mes** con IVA | ~\$4,625 MXN/mes con IVA |

Puntos clave:

- El costo **escala con el número de preguntas, no con el número de usuarios**.
  El motor del gasto es la IA (Gemini): **~\$0.28 MXN por pregunta** (~32 centavos con IVA).
- El **caché semántico** ya incluido en la app hace que las preguntas repetidas o muy
  similares cuesten **\$0** — en un equipo que consulta los mismos manuales esto
  recorta el gasto real un 20–40% (y más conforme crecen los usuarios).
- En el servidor actual el hosting tiene **costo marginal \$0** (ya está pagado);
  cada usuario cuesta exactamente lo que pregunta.
- **Contexto de mercado:** un bot comercial equivalente (Intercom Fin, Zendesk AI)
  costaría **\$63,000–190,000 MXN/mes** en el escenario de 20 usuarios — el sistema
  propio es 20–30× más barato que comprarlo hecho (detalle en la sección 9).

---

## 2. Qué consume el proyecto

El repositorio soporta **dos modos de despliegue**:

### a) On-premises (actual) — `docker-compose.prod.yml` + IIS
- La base de datos, los embeddings, la transcripción de video (Whisper) y el
  almacenamiento de archivos corren **en el propio servidor** → costo cloud \$0.
- **Único costo variable: Gemini 3.5 Flash vía Vertex AI** (la IA que responde).
- Este mismo stack Docker es el que correría en el VPS IONOS dedicado (sección 7).

### b) GCP Cloud Run (documentado en el README)
- Cloud Run (backend + frontend), Cloud SQL PostgreSQL + pgvector, bucket GCS,
  Artifact Registry, Secret Manager, Vertex AI (Gemini + embeddings).
- En este modo la transcripción de video **sí genera costo de cómputo facturable**
  (es intensiva en CPU), a diferencia del on-prem donde solo consume el servidor propio.

---

## 3. Costo de la IA — Gemini 3.5 Flash (Vertex AI, región us-central1)

| Concepto | USD por 1M tokens | MXN por 1M tokens |
|---|---|---|
| **Entrada ("leer")** | \$1.65 | **\$30.50** |
| **Salida ("responder")** | \$9.90 | **\$183.20** |
| Entrada cacheada | \$0.165 | \$3.05 |
| *(Referencia: endpoint global, no usado aquí)* | \$1.50 / \$9.00 | \$27.75 / \$166.50 |

> Regla práctica en español: **100 palabras ≈ 140 tokens** (1 token ≈ 3.5–4
> caracteres). Un millón de tokens ≈ 715,000 palabras ≈ 1,400 páginas.
> **Responder cuesta 6× más que leer** por token.
>
> ⚠️ Vertex AI **no tiene capa gratuita**. La versión "gratis" de Gemini existe solo
> en Google AI Studio (para pruebas, con límites y sin garantías empresariales de
> privacidad de datos); no es la que usa este proyecto.

### Ejemplos concretos en MXN (sin IVA)

**Entrada — lo que cuesta "leer":**

| Texto leído | Tokens aprox. | Costo MXN |
|---|---|---|
| Una pregunta típica del usuario (~25 palabras) | 35 | **\$0.001** (⅒ de centavo) |
| Una página de manual PDF usada como contexto (~500 palabras) | 700 | **\$0.02** |
| El prompt completo de una pregunta RAG (instrucciones + 4 fragmentos de manual + historial) | ~5,000 | **\$0.15** |
| Un millón de tokens (~1,400 páginas) | 1,000,000 | **\$30.50** |

**Salida — lo que cuesta "responder":**

| Respuesta generada | Tokens aprox. | Costo MXN |
|---|---|---|
| Respuesta corta (~100 palabras) | 140 | **\$0.026** |
| Respuesta típica con formato (~350 palabras) | 500 | **\$0.09** |
| Respuesta larga y detallada (~700 palabras) | 1,000 | **\$0.18** |
| Un millón de tokens de salida | 1,000,000 | **\$183.20** |

### Costo total por pregunta

| Componente | Costo MXN |
|---|---|
| Leer el prompt RAG (~5,000 tokens) | \$0.15 |
| Responder (~500 tokens) | \$0.09 |
| Llamadas auxiliares (sugerencias de seguimiento + título de sesión) | \$0.04 |
| **Total por pregunta mediana** | **\$0.28** (~\$0.32 con IVA) |
| Pregunta que pega en el caché semántico | **\$0.00** |

### Escenarios mensuales (solo Gemini)

| Escenario | Preguntas/mes | MXN/mes | Con IVA |
|---|---|---|---|
| Bajo | 1,500 (~50/día) | ~\$420 | ~\$490 |
| Medio | 6,000 (~200/día) | ~\$1,680 | ~\$1,950 |
| Alto | 30,000 (~1,000/día) | ~\$8,400 | ~\$9,740 |

**Embeddings:** despreciables (en on-prem son locales = \$0; en GCP, centavos).
**Ingesta de video:** sin costo de API (Whisper es local); en cloud se paga el
cómputo del procesamiento.

---

## 4. Hosting

### Servidor Windows actual (on-prem, compartido con VGD)
- **Costo marginal ≈ \$0**: el servidor ya está pagado.
- Certificado TLS: Let's Encrypt = **gratis**.
- Costo oculto honesto: **mantenimiento humano** (~2–4 h/mes: parches, backups,
  monitoreo) + la fracción prorrateada del servidor y la luz.

### GCP Cloud Run (si se migrara a nube administrada)

| Recurso | USD/mes | MXN/mes (sin IVA) |
|---|---|---|
| Cloud Run frontend+backend con apagado automático sin tráfico | \$0–10 | \$0–185 |
| Cloud Run con 1 instancia siempre encendida (recomendado: evita esperas de arranque) | \$15–50 | \$280–925 |
| Cloud SQL (base de datos) — **el costo fijo dominante**: básica \$8–26, estándar \$50–100 (+ ~\$1.70 por 10 GB) | \$10–100 | \$185–1,850 |
| Almacenamiento GCS (20–50 GB de docs/videos) + salida de datos por streaming de video | \$1–5 | \$20–90 |
| Registro de contenedores + gestor de secretos | \$1–3 | \$20–55 |
| **Total infraestructura** | **\$10–40 (mínimo) · \$60–150 (producción)** | **\$185–740 · \$1,110–2,775** (+16% IVA) |

---

## 5. Seguridad — Cloudflare

| Plan | MXN/mes (aprox., + IVA) | Incluye |
|---|---|---|
| **Free — \$0** | \$0 | Protección DDoS ilimitada, CDN, certificado SSL, firewall básico. **Suficiente para el despliegue actual** (además oculta la IP del servidor) |
| **Pro — \$20–25 USD** | \$370–465 | Firewall administrado con reglas OWASP, mejor protección anti-bots. El salto que vale la pena si el sitio se abre al público |
| Business — \$200+ USD | \$3,700+ | SLA y certificados custom — sobredimensionado para este proyecto |

La app ya trae defensas propias (límite de peticiones por usuario, cabeceras de
seguridad, validación de archivos subidos, sesiones con caducidad), así que
**Cloudflare Free cubre bien la capa de red sin costo**.

---

## 6. Opciones de despliegue comparadas

> Contexto: el sistema necesita tres piezas — la página web (frontend), el motor
> (backend en contenedores Docker) y una base de datos especial (Postgres con
> búsqueda vectorial). Las plataformas "solo frontend" (Vercel, AWS Amplify) **no
> pueden alojar el sistema completo**: sirven la página, pero el motor y la base
> siempre necesitan otro servicio.

| Opción | Infra MXN/mes (sin IVA) | Pros / Contras |
|---|---|---|
| **Servidor Windows actual (on-prem)** | ~\$0 | ✅ La más barata, ya montada. ❌ Servidor compartido, mantenimiento manual |
| **VPS IONOS XL+ (plan elegido — ver sección 7)** | ~\$815 | ✅ Mismo proveedor actual; tráfico ilimitado; el Docker corre tal cual. ❌ Operación manual |
| **VPS Hetzner (4 GB, Alemania)** | ~\$175 | ✅ Costo fijo bajísimo. ❌ Operación 100% manual; datacenter lejano; corto para 100+ usuarios con video |
| **VPS DigitalOcean (4 GB)** | ~\$445 | ✅ Buen soporte y datacenter cercano. ❌ Menos recursos que IONOS XL+ por precio similar |
| **Railway** | ~\$280–740 | ✅ El despliegue más simple: Docker + base de datos en un solo lugar. ❌ Menos control fino |
| **Render** | ~\$370–925 | ✅ Base de datos administrada con respaldos automáticos. ❌ Instancias pequeñas justas para procesar video |
| **Azure Container Apps + PostgreSQL** | ~\$280–1,110 | ✅ Capa gratuita similar a Cloud Run. ❌ La IA seguiría en Google → datos viajando entre nubes (latencia y costo extra) |
| **GCP Cloud Run + Cloud SQL** | ~\$185–2,775 | ✅ La IA (Vertex) ya vive ahí: una sola factura, cero fricción. ❌ La base de datos es costo fijo |
| **Vercel + Supabase (+ host para el backend)** | ~\$1,200 | ✅ Paquete moderno todo-incluido. ❌ Exige reescribir partes del backend; Vercel gratis prohíbe uso comercial |
| **AWS (Amplify + App Runner + RDS)** | ~\$740–2,220 | ❌ La más cara y la que más reingeniería exige |

### Recomendación

1. **Arranque (100–150 usuarios):** **VPS IONOS XL+** con el stack Docker de
   producción tal cual + **Cloudflare Free** (detalle en la sección 7).
2. **Si algún día se quiere nube administrada:** **GCP Cloud Run** — la IA ya corre
   en Google (una sola factura, sin datos cruzando entre proveedores). Azure/AWS no
   aportan nada aquí.

---

## 7. Escenario de arranque real: 100–150 usuarios en VPS IONOS

### Costo por usuario

Una "pregunta mediana" cuesta **\$0.28 MXN** (leer \$0.15 + responder \$0.09 +
llamadas auxiliares \$0.04). Sin IVA:

| Perfil de uso | Preguntas | Costo por usuario |
|---|---|---|
| 1 pregunta | — | \$0.28 |
| Uso en 1 día intensivo (20 preguntas) | 20 | **\$5.60 MXN/día** |
| **Usuario ligero** (3–5 preguntas/día, mes laboral de 26 días) | 78–130/mes | **\$22–36 MXN/mes** |
| **Usuario intensivo** (20 preguntas/día, mes laboral) | 520/mes | **~\$146 MXN/mes** |

> En soporte real la mayoría de la gente es "ligera" (3–5 consultas/día); el perfil
> intensivo es el techo, no el promedio. Y el caché semántico descuenta las
> preguntas repetidas del equipo (20–40% típico).

### El plan de VPS

IONOS (el mismo proveedor del servidor actual) ofrece estos planes con **tráfico
ilimitado** — importante porque el streaming de videos a 150 usuarios no cuesta
extra, a diferencia de la nube donde cada GB servido se factura:

| Plan IONOS (Linux) | Especificaciones | USD/mes (regular) | MXN/mes sin IVA |
|---|---|---|---|
| VPS L+ | 6 núcleos / 8 GB RAM / 240 GB NVMe | \$21 | ~\$390 |
| **VPS XL+ (recomendado)** | **8 núcleos / 16 GB RAM / 480 GB NVMe** | **\$44** | **~\$815** |
| VPS XXL+ | 12 núcleos / 24 GB RAM / 720 GB NVMe | \$68 | ~\$1,260 |

*Los precios de introducción de IONOS (\$11/mes el XL+ los primeros meses) son con
contrato anual; presupuestar siempre con el precio regular.*

- **XL+** aguanta cómodamente 150 usuarios: los picos de chat simultáneo (~10–25
  conversaciones a la vez) son ligeros para el backend, y los 8 núcleos absorben la
  transcripción de videos sin ahogar el chat. Los 480 GB dan años de crecimiento.
- **XXL+** solo si se suben videos constantemente o el corpus crece mucho.
- **Escalar es un clic:** IONOS permite subir de plan sin reinstalar nada — el stack
  Docker se mueve tal cual. Empezar en XL+ y crecer si hace falta.
- **Elegir Linux, no Windows:** el stack completo corre en contenedores Linux; en un
  VPS dedicado no se necesita IIS (nginx puede terminar el TLS con certificado
  gratuito). Un VPS Windows cobra además la licencia de Windows Server — dinero
  tirado en este caso.

### Costo de la IA a esta escala (125 usuarios promedio, mes laboral de 26 días)

| Escenario | Preguntas/mes | IA MXN (sin IVA) | **TOTAL con VPS XL+, con IVA** | Por usuario |
|---|---|---|---|---|
| Ligero (4 preguntas/día todos) | 13,000 | ~\$3,640 | **~\$5,170** | ~\$41 |
| **Mixto realista (80% ligero, 20% intensivo)** | ~23,400 | ~\$6,550 | **~\$8,550** | **~\$68** |
| Techo (todos 20 preguntas/día) | 65,000 | ~\$18,200 | ~\$22,060 | ~\$176 |

- El **caché semántico rinde más con más usuarios** (más gente repite las mismas
  dudas): a esta escala es razonable esperar 30–50% de descuento real en la línea
  de IA → el escenario mixto real rondaría **\$4,750–6,270 MXN/mes con IVA**.
- A esta escala, **el piloto de Gemini Flash-Lite ya se paga solo**: en el escenario
  mixto la IA bajaría de ~\$6,550 a ~\$865 MXN — un ahorro de ~\$5,700 MXN/mes que sí
  justifica invertir unas horas en validar su calidad en español (ver sección 10).
- La brecha contra comprar un bot comercial se agranda: 23,400 preguntas/mes en
  Intercom Fin serían del orden de **\$171,000 MXN/mes** (ver sección 9).

### Qué más considerar al escalar a 100–150 usuarios

| Consideración | Qué hacer | Costo |
|---|---|---|
| **Respaldo externo** — a esta escala ya es obligatorio, no opcional | Respaldo diario de base de datos y archivos a almacenamiento externo (Backblaze B2 / GCS coldline), o el add-on de backup de IONOS | ~\$10–60 MXN/mes |
| **Cloudflare delante del dominio** | Plan Free: oculta la IP del VPS, absorbe ataques, acelera la carga | \$0 |
| **Monitoreo de disponibilidad** | UptimeRobot u otro servicio de ping cada 5 min con alerta por correo | \$0 |
| **Alerta de presupuesto en GCP** | Tope de gasto con aviso al 50/90/100% — el gasto de IA ahora es 5–7× mayor y un bucle costaría más | \$0 |
| **Cuotas de Vertex AI** | Los límites por defecto (peticiones/minuto) alcanzan; si los picos crecieran, el aumento de cuota se solicita gratis en la consola | \$0 |
| **Prueba de carga antes del go-live** | Simular 25–50 chats simultáneos contra el VPS para validar el dimensionamiento | Horas técnicas |
| **Alta masiva de usuarios** | Crear 100–150 cuentas una por una en el panel admin es tedioso; considerar una mejora de importación por CSV | Horas de desarrollo |
| **Renovación IONOS** | Los precios de introducción suben al renovar (XL+: \$11 → \$44 USD); presupuestar con el precio regular desde el día 1 | — |

---

## 8. Referencia comparativa: 20 usuarios (escala piloto)

*Esta sección se conserva como referencia para dimensionar un piloto pequeño o
comparar plataformas en igualdad de condiciones; el escenario real del proyecto es
el de la sección 7.*

### TOTAL mensual — 20 usuarios, por plataforma (ordenado de menor a mayor)

Gemini: uso ligero ≈ \$585 MXN · uso intensivo ≈ \$2,910 MXN (sin IVA, sin descontar caché).

| Plataforma | Infra MXN | **TOTAL ligero (con IVA)** | **TOTAL intensivo (con IVA)** | Por usuario (intensivo) |
|---|---|---|---|---|
| **Servidor Windows actual** | \$0 | **~\$680** | **~\$3,380** | **~\$169** |
| VPS Hetzner | ~\$175 | ~\$880 | ~\$3,580 | ~\$179 |
| VPS DigitalOcean | ~\$445 | ~\$1,190 | ~\$3,895 | ~\$195 |
| Railway | ~\$555 | ~\$1,320 | ~\$4,020 | ~\$201 |
| Render | ~\$650 | ~\$1,430 | ~\$4,130 | ~\$207 |
| Azure | ~\$740 | ~\$1,535 | ~\$4,235 | ~\$212 |
| GCP Cloud Run | ~\$1,075 | ~\$1,920 | ~\$4,625 | ~\$231 |
| Vercel + Supabase + backend aparte | ~\$1,200 | ~\$2,065 | ~\$4,770 | ~\$239 |
| AWS | ~\$1,480 | ~\$2,390 | ~\$5,095 | ~\$255 |

Notas:

- Con 20 usuarios **cualquier plataforma va sobrada de capacidad**; la diferencia
  es casi puro costo fijo de infraestructura.
- Con el caché semántico, la línea de Gemini en uso intensivo baja en la práctica a
  ~\$1,745–2,330 MXN → los totales con IVA quedarían **\$675–1,350 MXN por debajo**
  de lo tabulado.
- En plataformas con costo fijo (GCP, etc.) el costo por usuario **mejora con la
  escala**: en GCP, con 50 usuarios sale ~\$195/usuario y con 100 ~\$180 (el fijo se
  reparte). En el servidor propio siempre es el mínimo posible.
- Si el uso se duplica, **solo crece la línea de la IA** (lineal); la infraestructura
  no cambia a esta escala. Ese es el punto fuerte del diseño actual.

---

## 9. Construir vs. comprar — lo que costaría un bot comercial

Los bots de soporte comerciales (SaaS) cobran **por resolución**, no por pregunta:

| Solución | Precio por interacción | Costo fijo adicional |
|---|---|---|
| **Intercom Fin** | \$0.99 USD por resolución ≈ **\$18.30 MXN** | + \$39 USD/asiento/mes |
| **Zendesk AI** | \$1.50–2.00 USD por resolución ≈ \$28–37 MXN | + \$50 USD/agente/mes obligatorio + plan Zendesk |
| **Nexus Support Agent (este proyecto)** | **\$0.28 MXN por pregunta** | \$0 (servidor actual) |

Comparativa con el escenario de 20 usuarios intensivos (10,400 preguntas/mes):

| | Costo mensual estimado |
|---|---|
| Intercom Fin, si cada pregunta fuera una resolución | ~\$190,000 MXN |
| Intercom Fin, conservador (1 resolución ≈ 2–3 preguntas) | ~\$63,000–95,000 MXN |
| **Nexus Support Agent (con IVA)** | **~\$3,380 MXN** |

Aun con el supuesto más conservador, el sistema propio es **20–30× más barato** que
la alternativa comercial equivalente — sin contar licencias por asiento. Como
referencia adicional, la industria reporta costos operativos típicos de chatbots
empresariales de **\$1,000–15,000 USD/mes**; este proyecto opera todo incluido en
~\$155–400 USD/mes según la escala. **Esta es la justificación económica central del
desarrollo propio.**

---

## 10. Opciones de IA más baratas — dentro y fuera de Google

### La palanca interna: Gemini Flash-Lite (mismo proveedor, misma privacidad)

Google ofrece un tramo más barato dentro del propio Vertex AI:

| Modelo | USD entrada/salida por 1M | Costo por pregunta mediana | vs. actual |
|---|---|---|---|
| Gemini 3.5 Flash (**actual**) | \$1.65 / \$9.90 | \$0.28 MXN | — |
| **Gemini 3.1 Flash-Lite** | ~\$0.25 / \$1.50 | **~\$0.04 MXN** | ~7× más barato |

El cambio es una línea de configuración, con las **mismas garantías de privacidad y
la misma factura**. El matiz: es un modelo menos capaz, y habría que validar la
calidad de las respuestas en español antes de adoptarlo (el proyecto está
estandarizado en 3.5 Flash por su calidad). **Si algún día hay que recortar el gasto
de IA, este es el primer paso — no los modelos chinos.**

### ¿Y los modelos chinos? (DeepSeek, Qwen) — más baratos, pero con letra chica

Los modelos de IA chinos son hoy los más baratos del mercado por token:

| Modelo (API) | USD entrada/salida por 1M | Costo por pregunta mediana | vs. Gemini 3.5 Flash |
|---|---|---|---|
| **DeepSeek V4 Flash** | \$0.14 / \$0.28 | **~\$0.016 MXN** (1.6 centavos) | ~18× más barato |
| **Qwen3.6-Plus** (Alibaba) | \$0.325 / \$1.95 | ~\$0.05 MXN | ~6× más barato |

En el escenario real (125 usuarios, uso mixto), la línea de IA bajaría de ~\$6,550 a
**~\$370 MXN/mes** con DeepSeek. Entonces, ¿por qué no cambiarse?

**El problema no es el precio, es a dónde viajan los datos:**

- Usar la API de DeepSeek o de Alibaba Cloud significa enviar cada pregunta —
  incluidos los fragmentos de manuales internos y lo que escriban los usuarios — a
  **servidores bajo jurisdicción china**, donde la legislación (PIPL y la Ley de
  Inteligencia Nacional) obliga a los proveedores a cooperar con el Estado y **no
  existen los contratos de protección de datos, certificaciones y garantías de
  residencia de datos** que sí ofrecen GCP, AWS o Azure.
- Para una empresa mexicana que maneja información de clientes y operaciones,
  esto genera riesgo de cumplimiento (LFPDPPP) y riesgo reputacional que el ahorro
  difícilmente compensa.
- **Matiz importante:** DeepSeek y Qwen son de "pesos abiertos" — pueden alquilarse
  hosteados en nubes occidentales (Together AI, Fireworks, incluso la propia GCP)
  con garantías occidentales de privacidad. Sale más caro que la API china pero aún
  menos que Gemini. Aun así, el ahorro extra frente a Flash-Lite es marginal
  (unos cientos de pesos al mes) y no paga el trabajo de integración ni la
  validación de calidad en español que exigiría.

### Tabla cruzada: hosting × modelo de IA (escenario real: 125 usuarios, uso mixto, ~23,400 preguntas/mes)

| Combinación | IA MXN/mes | Infra MXN/mes | **TOTAL con IVA** | Nota |
|---|---|---|---|---|
| **VPS IONOS XL+ + Gemini 3.5 Flash** | ~\$6,550 | ~\$815 | **~\$8,550** | ✅ **Plan del proyecto** |
| VPS IONOS XL+ + Gemini Flash-Lite | ~\$865 | ~\$815 | **~\$1,950** | Misma privacidad; requiere validar calidad en español |
| VPS IONOS XL+ + open-weight en nube occidental (DeepSeek/Qwen vía Together, Fireworks…) | ~\$770–1,480* | ~\$815 | ~\$1,840–2,660 | Privacidad occidental; exige trabajo de integración |
| VPS IONOS XL+ + DeepSeek API china | ~\$370 | ~\$815 | ~\$1,375 | ❌ **No recomendado** (datos bajo jurisdicción china) |
| GCP Cloud Run + Gemini 3.5 Flash | ~\$6,550 | ~\$1,075 | **~\$8,850** | La migración a nube "natural" |
| GCP Cloud Run + Gemini Flash-Lite | ~\$865 | ~\$1,075 | ~\$2,250 | La nube más barata con calidad por validar |

*\*Estimado: los proveedores occidentales de modelos abiertos cobran típicamente
2–4× la API china; el precio exacto depende del proveedor y modelo elegido.*

En todas las combinaciones el caché semántico descuenta además un 20–40% de la
línea de IA (y más conforme crecen los usuarios).

La tabla deja ver el mensaje completo: **el ahorro grande ya está disponible dentro
de Google sin ningún riesgo de privacidad** — pasar de Gemini 3.5 Flash a Flash-Lite
bajaría el total de ~\$8,550 a ~\$1,950 MXN/mes. Bajar de ahí a la API china solo
ahorraría ~\$575 MXN/mes más, a cambio de enviar los datos a jurisdicción china:
un mal negocio se mire por donde se mire.

**Conclusión:** a la escala actual, quedarse en Gemini/Vertex es la decisión
correcta. Si el gasto de IA creciera mucho, el orden de exploración sería:
1º Gemini Flash-Lite (mismo Google), 2º modelos open-weight hosteados en nube
occidental, y solo como último recurso las APIs chinas directas.

---

## 11. Costos únicos y consideraciones finales

| Concepto | Costo |
|---|---|
| Dominio (app-nexusqtech.com) | ~\$300–500 MXN/año |
| Certificado TLS (Let's Encrypt) | \$0 |
| Desarrollo de la aplicación | Ya realizado (costo hundido) |
| Mantenimiento del servidor | ~2–4 h/mes de tiempo técnico |

- **IVA:** los proveedores cloud facturan +16% en México; para la empresa suele ser
  acreditable, por lo que el costo financiero real es el subtotal sin IVA.
- **Tipo de cambio:** todo el documento presupuesta a **\$18.50 MXN/USD (colchón)**;
  al tipo de cambio real de hoy (~\$17.80) los costos serían ~4% menores. Si el peso
  se deprecia más allá de \$18.50, recalcular.
- **El diseño protege el bolsillo:** caché semántico + razonamiento desactivado
  (`thinkingBudget=0`) + solo 4 fragmentos de contexto por pregunta ya son
  optimizaciones de costo activas.

### Costos ocultos y salvaguardas (lo que la industria suele pasar por alto)

- **La configuración ES el costo:** los \$0.28/pregunta dependen de la configuración
  actual (4 fragmentos de contexto, historial de 6 mensajes, razonamiento apagado).
  Subir los fragmentos de 4 a 8 casi **duplicaría** el costo por pregunta sin que
  nadie lo note. Cualquier ajuste de estos parámetros debe recalcular este reporte.
- **Re-indexación:** si se cambia la estrategia de troceo de documentos, todo el
  corpus se re-procesa. En el servidor propio es **gratis** (embeddings locales);
  en el modo GCP costaría (poco, pero costaría).
- **Ciclo de vida del modelo:** Google retira modelos Gemini periódicamente
  (~cada 1–2 años). Presupuestar unas horas de migración/validación anuales.
- **Los precios de IA cambian:** Google ha ajustado tarifas al alza y a la baja;
  revisar este reporte trimestralmente o cuando Google anuncie cambios.
- **Alerta de presupuesto (gratis):** configurar un tope de gasto en la consola de
  GCP con aviso por correo — evita sorpresas en la factura si algo entra en bucle.
- **Respaldo externo (pendiente recomendado):** hoy los datos viven solo en el
  servidor; un respaldo a almacenamiento frío externo (~\$10–60 MXN/mes,
  p. ej. Backblaze B2 o GCS coldline) cubriría la pérdida total del servidor.
- **Lo que ya está cubierto gratis:** la industria presupuesta \$200–2,500 USD/mes
  en herramientas de evaluación y observabilidad; aquí el sistema de calificación
  con pulgares y el panel de administración ya cumplen ese rol sin costo.
- **Recalibrar tras el arranque:** los escenarios de uso son estimaciones; después
  del primer mes con usuarios reales, medir las preguntas/día efectivas y la tasa
  de aciertos del caché, y actualizar este reporte con datos reales.

---

## 12. Glosario (para lectores no técnicos)

| Término | Qué significa |
|---|---|
| **Token** | La unidad en que la IA mide el texto; ~100 palabras ≈ 140 tokens. Se paga por token leído y por token generado |
| **LLM / Modelo** | El "cerebro" de IA que redacta las respuestas (aquí: Gemini 3.5 Flash) |
| **RAG** | Técnica donde la IA responde *leyendo primero* fragmentos de los manuales reales, en vez de inventar de memoria |
| **Embedding** | Huella numérica de un texto que permite buscar por significado, no solo por palabra exacta |
| **Caché semántico** | Memoria de preguntas ya respondidas: si alguien pregunta algo igual o muy parecido, se reutiliza la respuesta gratis |
| **Vertex AI** | La plataforma de Google Cloud donde se contrata Gemini para empresas |
| **Cloud Run** | Servicio de Google que ejecuta la aplicación y cobra solo por el tiempo usado |
| **VPS** | Servidor virtual rentado por mes (tú lo administras todo) |
| **On-premises** | Instalado en servidor propio, no en la nube |
| **Egress / salida de datos** | Lo que cobra la nube por los datos que salen hacia internet (p. ej. ver un video) |
| **CDN** | Red que entrega la página más rápido desde ubicaciones cercanas al usuario |
| **WAF** | Firewall de aplicaciones web: filtra ataques antes de que lleguen al sistema |
| **DDoS** | Ataque de saturación con tráfico masivo; Cloudflare lo bloquea gratis |
| **pgvector** | Extensión de la base de datos que permite la búsqueda por significado |

---

## Fuentes

- [Gemini API pricing (Google)](https://ai.google.dev/gemini-api/docs/pricing)
- [Vertex AI Generative AI pricing (Google Cloud)](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Gemini 3.5 Flash pricing guide 2026](https://evolink.ai/blog/gemini-3-5-flash-pricing-guide)
- [Cloud Run pricing](https://cloud.google.com/run/pricing) · [Cloud SQL pricing](https://cloud.google.com/sql/pricing) · [Guía Cloud SQL 2026](https://www.usage.ai/blogs/gcp/cloud-sql/pricing/)
- [Cloudflare plans](https://www.cloudflare.com/plans/) · [Comparativa Cloudflare 2026](https://eastondev.com/blog/en/posts/dev/20251201-cloudflare-pricing-compare/)
- [Vercel pricing](https://vercel.com/pricing) · [Vercel cost 2026](https://makerkit.dev/blog/saas/vercel-cost)
- [AWS Amplify pricing](https://aws.amazon.com/amplify/pricing/) · [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- [Railway vs Render vs Fly.io 2026](https://hostim.dev/blog/render-vs-railway-vs-fly-pricing/)
- [Supabase pricing](https://supabase.com/pricing) · [Neon vs Supabase 2026](https://designrevision.com/blog/supabase-vs-neon)
- [DigitalOcean vs Hetzner 2026](https://betterstack.com/community/guides/web-servers/digitalocean-vs-hetzner/)
- [IONOS VPS (planes y precios oficiales)](https://www.ionos.com/servers/vps) · [IONOS pricing: renovaciones y costos ocultos](https://hostadvice.com/hosting-company/ionos-reviews/pricing/)
- [DeepSeek API pricing 2026](https://pricepertoken.com/pricing-page/provider/deepseek) · [DeepSeek vs Qwen 2026](https://pricepertoken.com/compare/provider/deepseek-vs-qwen) · [Guía DeepSeek API 2026](https://www.nxcode.io/resources/news/deepseek-api-pricing-complete-guide-2026)
- [Intercom Fin pricing 2026](https://minami.ai/blog/intercom-fin-ai-agent-pricing) · [Intercom pricing oficial](https://www.intercom.com/pricing) · [Zendesk AI pricing por resolución 2026](https://corepiper.com/blog/zendesk-ai-agent-pricing-2026/)
- [Gemini 3.1 Flash-Lite pricing](https://pricepertoken.com/pricing-page/model/google-gemini-3.1-flash-lite-preview) · [Guía de precios Gemini API 2026](https://www.metacto.com/blogs/the-true-cost-of-google-gemini-a-guide-to-api-pricing-and-integration)
- [RAG en producción: sorpresas de costos](https://www.kalviumlabs.ai/blog/rag-in-production-what-it-actually-costs-after-sprint-3/) · [Costo real de un chatbot empresarial 2026](https://t3c.ai/blog/enterprise-chatbot-cost-2026) · [Costos ocultos de LLMs en producción](https://medium.com/design-bootcamp/the-hidden-costs-of-running-llms-in-production-and-what-to-do-about-them-a17b496aa09d)
- [Tipo de cambio USD/MXN — El Universal](https://www.eluniversal.com.mx/consultas/precio-dolar-hoy/) · [Banxico](https://www.banxico.org.mx/SieInternet/consultarDirectorioInternetAction.do?sector=6&accion=consultarCuadro&idCuadro=CF373&locale=es)
