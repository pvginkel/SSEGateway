# SEED-NOTES — ssegateway producer

First architecture artifact for SSEGateway. Hand-authored mode (the YAML is the
source of truth; no generator). Authored headless — modeling decisions made
best-effort; open questions are at the bottom.

## Identity (fixed by the seeding brief, not re-derived)

- Producer id (envelope `producer:` key): `ssegateway`.
- `introduced` date on every element: `2025-11-18` — this repo's first commit
  (`git log --reverse --format=%ad --date=short | head -1`).
- Mode: hand-authored. uuid4 minted once per element, never re-minted.

## Element inventory (minted ids)

| Kind | id | label |
|---|---|---|
| ApplicationComponent «SoftwareProduct» | `app:ssegateway,447e208d-43de-4f2a-942c-84fc9cdfac45` | SSEGateway |
| ApplicationService | `svc:ssegateway,59a7d043-bb0c-4e44-a8b8-3e943338f807` | SSEGateway event delivery |
| ApplicationInterface | `if:ssegateway-publish,d052e430-a661-46f5-9da2-c8f99e27be24` | SSEGateway backend integration |
| ApplicationInterface | `if:ssegateway-stream,ecadf67b-368d-4aed-b3db-4afc4d59e2d0` | SSEGateway client stream |

- `app:ssegateway` carries `stereotype: SoftwareProduct`,
  `sourceRepository: git:pvginkel/SSEGateway`, and `stats.image: registry:5000/ssegateway`.
- `environment`/`cluster` left UNSET on all four: these are logical, type-level
  surfaces that span every deployed env. Per-env placement (running instances,
  Specialization edges, public interface hosts) is the HelmCharts deployer's job.

## Relations

| id | edge | type |
|---|---|---|
| `rel:ssegateway-realizes-svc` | `app:ssegateway → svc:ssegateway` | Realization |
| `rel:ssegateway-publish-assigns-svc` | `if:ssegateway-publish → svc:ssegateway` | Assignment |
| `rel:ssegateway-stream-assigns-svc` | `if:ssegateway-stream → svc:ssegateway` | Assignment |
| `rel:ssegateway-consumes-pub-sub` | `app:ssegateway → cap:pub-sub-broker` (boundBy `env:RABBITMQ_URL`) | Association |

## Modeling decisions

### Exposed service: one ApplicationService, two ApplicationInterfaces

SSEGateway is an in-house provider; its event-delivery API is a dependency
target for many backends, so it is modelled as ONE `ApplicationService`
(`svc:ssegateway`) realized by the product. Backends reference this service's
UUID as their `boundBy` target.

The service has two genuinely distinct consumer classes, so it gets one
interface each (per-consumer, not per-route, per the manual):

- **`if:ssegateway-publish`** — in-house **backend services**. They integrate via
  the connect/disconnect callback contract and the HTTP-only `POST /internal/send`
  publish endpoint. This is the federation-relevant consumer.
- **`if:ssegateway-stream`** — **browser SSE clients**. They open `GET /<any-path>`
  and receive a `text/event-stream`.

Alternative considered: collapse to a single interface (the seeding brief's
fixed-facts text said "with an interface", singular). Rejected because the
browser-stream and backend-publish surfaces are genuinely different client types
— exactly the case the manual says warrants separate interfaces. Easy to merge
later if the operator prefers one.

### Outbound dependency: RabbitMQ → `cap:pub-sub-broker`

The repo gained a RabbitMQ transport (`src/rabbitmq.ts`, `RABBITMQ_URL`) since
CLAUDE.md was last written. The gateway asserts a **topic exchange** `sse.events`
and consumes per-connection queues bound to backend-supplied routing keys
(`README.md` "How it works"; `src/rabbitmq.ts:525` `assertExchange(..., 'topic')`).
Topic-based publish/subscribe → `cap:pub-sub-broker`. RabbitMQ is substitutable
in-house infra, so the target is a curated capability with REQUIRED
`boundBy: "env:RABBITMQ_URL"` (the AMQP URL carries the endpoint —
`src/config.ts:67`). Source of the edge is the consumer (`app:ssegateway`).

### `CALLBACK_URL` deliberately NOT modelled

`CALLBACK_URL` (`src/config.ts:50`, `src/callback.ts`) points at the **consuming
backend** — the gateway POSTs connect/disconnect notifications to it. This is the
gateway *serving its consumer*, configured per-deployment (the gateway is a
sidecar deployed alongside each backend). Per the locked conventions, the
SSE-gateway callback the app exposes is an implementation detail of consuming the
gateway: the **backend's own producer** owns the consumption edge
(`backend —Association→ svc:ssegateway`, boundBy the gateway URL var). Modelling a
gateway→backend edge here would be a trivial provider→consumer back-call and would
double-count the integration. Omitted.

### No capability realized

There is no SSE / real-time-event-delivery capability in the v0.1 enum, and the
gateway is not itself a pub/sub broker (it *consumes* one). Per the manual most
apps realize none, so `app:ssegateway` realizes no `cap:`. See open questions.

## Outbound dependency survey

- `grep -rIi '://' src/` → only hit is a WHATWG spec URL in a `src/sse.ts`
  comment. OUT (documentation URL).
- Env/config scan (`src/config.ts`): `PORT`, `CALLBACK_URL`,
  `HEARTBEAT_INTERVAL_SECONDS`, `RABBITMQ_URL`, `RABBITMQ_QUEUE_TTL_MS`,
  `RABBITMQ_ENV_PREFIX`, `RABBITMQ_ENV_AUTO_DELETE`. Only `RABBITMQ_URL` carries a
  provider endpoint (→ the dependency above). `CALLBACK_URL` is the consumer
  back-call (excluded, above). The rest are tuning/sizing, not dependency edges.

## Out of scope (inclusion rule / lens)

- `GET /healthz`, `GET /readyz` — operational health surfaces, not a named
  consumer-reachable API; belong to the deployment lens. OUT.
- Heartbeat / queue-TTL / buffering internals — runtime behaviour, no external
  identity. OUT.
- Container image build / npm-package distribution — build artifacts, not
  architecture elements (image recorded only as `stats` on the product). OUT.

## Cross-producer references

- `cap:pub-sub-broker` — curated capability, referenced by bare name (resolved
  from the central enum at merge time). No UUID lookup needed.
- No cross-producer UUID references authored. The running RabbitMQ instance and
  SSEGateway's deployed pods/instances belong to other producers (HelmCharts /
  Ansible) and are not referenced here. No dangling refs introduced.

## Open questions for the operator (would have asked a human)

- **One interface vs two?** I split backend-publish from browser-stream. If you
  prefer the single-interface framing from the fixed-facts text, drop
  `if:ssegateway-stream` and its Assignment edge.
- **`cap:pub-sub-broker` vs `cap:message-queue`?** The exchange is a `topic`
  exchange (pub/sub fan-out by routing key), so I chose `pub-sub-broker`. If the
  intended modelling treats the per-connection durable queues as point-to-point,
  `cap:message-queue` would be the call.
- **Is a real-time-event-delivery / SSE capability warranted?** The gateway
  provides a recognizable platform capability (SSE termination + event fan-out)
  that no enum entry names. If you want it to `Realize` a capability, that's a PR
  against the Architecture repo's capability enum.
