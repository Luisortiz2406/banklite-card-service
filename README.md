# Card Service (`card-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-card-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-card-service/actions/workflows/deploy.yml)

Tarjetas débito virtuales: emisión, controles, compras simuladas y suscripciones con cobro mensual.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Emite tarjetas virtuales asociadas a una cuenta, guarda el número **cifrado con AES-256**
y aplica los controles que el cliente configura antes de autorizar cada cargo. Las
compras y los cobros de suscripciones se registran en ledger-service; cada intento
(aprobado o rechazado) queda en `card_authorizations`.

**Reglas de negocio principales**

- Una tarjeta **congelada** o cancelada no autoriza cargos.
- Compras por internet solo si el control `online_enabled` está activo.
- Límite diario por tarjeta (mínimo publicado en `GET /cards/catalog`, máximo el límite diario de la cuenta) sumando lo aprobado del día.
- El número completo solo se descifra para el titular de la tarjeta.
- Suscripciones: aviso 3 días antes, cobro mensual, rechazo por fondos o controles y suspensión tras 3 intentos fallidos.
- Cuenta cancelada por el cliente (`account.closed`): todas sus tarjetas pasan a `cancelled` y sus suscripciones a `cancelled`; se borra el número cifrado de la tarjeta (`pan_encrypted` queda vacío) y solo se conservan los últimos 4 dígitos. Las filas no se borran. Una tarjeta cancelada es definitiva: no se reactiva, no se revela el número, no cambia sus controles y rechaza toda compra («La tarjeta fue cancelada.»). Un cobro de suscripción que termina después del cierre no la reactiva.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `subscription.charge_upcoming` / `charged` / `charge_rejected` / `suspended` → notification<br>`card.controls_changed`, `card.charge_declined` → notification |
| Consume eventos | `account.closed` (account-service) → cancela tarjetas y suscripciones del cliente. Cola `card-service.account-closed`, con `.retry` y `.dlq`; procesarlo dos veces es inofensivo. |
| Llama a | account-service: dueño y límite de la cuenta<br>ledger-service: cargos (`/ledger/internal/payments`)<br>auth-service: clave dinámica |
| Lo llaman | Operación: `POST /internal/subscriptions/run-billing` (clave `ops:` opcional)<br>api-gateway (rutas `/cards/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/cards`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`card_db`)

| Tabla | Contenido |
|---|---|
| `cards` | Tarjetas (número cifrado, últimos 4, estado `active` / `frozen` / `cancelled`, controles). `cancelled_at`: cuándo se canceló por el cierre de la cuenta; desde ahí `pan_encrypted` es `NULL`. |
| `card_authorizations` | Intentos de cargo aprobados y rechazados (motivo). |
| `card_settings_audit` | Cambios de controles hechos por el cliente. |
| `merchants` | Comercios de compras y suscripciones. |
| `subscriptions` | Suscripciones inscritas y su estado. |
| `subscription_charges` | Cobros de cada periodo. |
| `card_outbox` | Outbox de eventos. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb card_db
psql "postgres://usuario:clave@localhost:5432/card_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-card-service .
docker run --env-file .env -p 3007:3007 banklite-card-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3007/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/cards/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/cards/catalog` | Rango del límite diario de la tarjeta. |
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/cards/purchase-stores` | Comercios para la compra simulada. |
| GET | `/cards/:id/controls` | Controles de la tarjeta. |
| PATCH | `/cards/:id/controls/online` | Activa o desactiva compras por internet. |
| PATCH | `/cards/:id/controls/daily-limit` | Cambia el límite diario. |
| POST | `/cards/:id/purchases` | Compra simulada (aplica los controles y cobra en el ledger). |
| GET | `/cards` | Tarjetas del cliente. |
| POST | `/cards` | Emite una tarjeta virtual para una cuenta propia. |
| GET | `/cards/:id/reveal` | Número completo de una tarjeta propia (se descifra al pedirlo). |
| PATCH | `/cards/:id/status` | Congela o descongela la tarjeta. |
| GET | `/cards/subscriptions/catalog` | Servicios disponibles para suscribirse. |
| GET | `/cards/subscriptions` | Suscripciones del cliente. |
| POST | `/cards/subscriptions` | Inscribe una suscripción a una tarjeta. |
| GET | `/cards/subscriptions/:id/charges` | Historial de cobros. |
| POST | `/cards/subscriptions/:id/pause` | Pausa la suscripción. |
| POST | `/cards/subscriptions/:id/resume` | La reanuda. |
| DELETE | `/cards/subscriptions/:id` | La cancela. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/cards/admin/cards` | support, compliance, admin | Tarjetas (solo últimos 4 dígitos y estado). |
| GET | `/cards/admin/cards/:id/declines` | support, compliance, admin | Intentos de cargo rechazados de una tarjeta. |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/subscriptions/run-billing` | Corre el cobro mensual de todas las suscripciones. |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3007` | Puerto HTTP del servicio. |
| `METRICS_PORT` | No | `9100` | Puerto de `GET /metrics` (Prometheus), solo para la red privada; **no** es el puerto público (`PORT`). `off` lo apaga. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://card_svc:<DB_PASSWORD_CARD>@localhost:5432/card_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `CARD_ENCRYPTION_KEY` | **Sí** (no arranca sin ella) | — | Llave AES-256 (64 hex) de los números de tarjeta. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `INTERNAL_TRUSTED_KEYS` | No | — | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `AUTH_SERVICE_URL` | Sí | `http://localhost:3001` | URL interna de auth-service. |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `RABBITMQ_QUEUE` | No | `card-service.account-closed` | Cola donde escucha `account.closed`. |
| `ALLOW_BILLING_DATE_OVERRIDE` | No | `false` | Solo pruebas locales: fecha simulada en el cobro de suscripciones. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

Pruebas de reglas de negocio (Jest): tarjeta congelada, compras por internet desactivadas, límite diario (el menor entre tarjeta y cuenta, también con compras simultáneas), idempotencia del cobro y clave dinámica.

Corren contra un PostgreSQL real, porque esas reglas dependen de transacciones,
bloqueos e índices únicos. Cada corrida crea una base temporal y la borra al terminar:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Sin `TEST_DATABASE_URL` se omiten en local; en la CI son obligatorias (el workflow
levanta un Postgres de servicio).

También se prueban: el **cobro de suscripciones** (el primer mes se cobra de verdad o no se inscribe nada; un periodo no se cobra dos veces; un rechazo reintenta al día siguiente y tras 3 reintentos se suspende; si el ledger no responde el cobro se aplaza sin gastar un reintento; el candado de la tarea diaria; pausar, reanudar y cancelar, también si se cancela mientras se cobra), el **cobro al ledger** (un 4xx es rechazo con el motivo del ledger; 5xx, sin respuesta o clave interna rechazada es "no disponible" y no se reintenta solo), la **emisión y el cifrado de la tarjeta** (número con Luhn, AES-256-GCM, el CVV no se guarda, solo el titular lo ve), el panel administrativo (nunca expone el número), el outbox, los controladores, los guards, `/health` y la validación de configuración.

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de 70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy está en 80,9 % de líneas y 78,2 % de ramas.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas con Postgres (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-card-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `card-service`: `status` y `database` deben estar en `ok`)
- Endpoint público de prueba: https://api-gateway-production-dd7f.up.railway.app/cards/catalog
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/cards/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** dueño y límite de la cuenta<br>**Recibe:** `account.closed` (cancela tarjetas y suscripciones) |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** cargos (`/ledger/internal/payments`) |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Llama a:** verificación de la clave dinámica |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Envía:** `subscription.*`, `card.controls_changed`, `card.charge_declined` |
