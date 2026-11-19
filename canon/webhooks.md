# Company webhook canon

Mission: keep webhook creation unique and delivery authenticated and replay-safe.
Audience: agents and engineers creating or operating company webhooks.
Tracked in Linear: JOV-13083.

## Register before creating

Every inbound or outbound webhook is an entry of kind `webhook` in
[`resources.json`](resources.json), with `name`, `provider`, `scope`, `events`,
`target`, `secretEnv`, `owner` and `linear`. Include a `purposeKey`, `purpose`,
`family` and `status`. Webhook names share the normal cross-kind namespace.

Before creating one, run `registry-check can-create --kind webhook ...`.
In this repository the guard is invoked as:

```sh
node guards/resources.mjs can-create --kind webhook \
  --name registry-create-github-org --purpose-key registry-create-github --family ci
```

Exit 1 means reuse the existing entry; do not create a duplicate or rename to
dodge it. `active_uncommissioned` reserves live names and purposes even before
creation. This change registers only the two registry-create webhooks; the
inventory of other existing webhooks is a separate follow-up.

## Authenticate and guard against replay

Every receiver verifies the provider signature over the raw request body before
parsing or relaying it. Compare signatures in constant time and reject unsigned
requests and bad signatures.

| Provider | Signature header | Algorithm |
| --- | --- | --- |
| GitHub | `X-Hub-Signature-256` | HMAC-SHA256 |
| Vercel | `x-vercel-signature` | HMAC-SHA1 |
| Linear | `linear-signature` | HMAC-SHA256 |

Every receiver also has replay protection: delivery-id dedupe and/or a timestamp
window. Secrets come from environment variables only; each registry entry's
`secretEnv` names the variable, never its value.

## Hosts, relays and scheduling

Prefer existing hosts, including the Jovie app's `/api/webhooks/*` routes.
Never create a Vercel project for a webhook. Relays send minimal payloads:
`repository_dispatch` event `resource-created` carries only `{kind,name}` in its
`client_payload`.

Prefer events over polling. Any cron a webhook replaces stays only as a
documented backstop. For registry-create, the daily `resource-drift-scan` cron
is the backstop for missed deliveries.

## Registry-create flow and held steps

Intended flow (activation remains held):

```text
GitHub org repository / Vercel project.created
  -> Jovie /api/webhooks/registry-create (verify, replay-guard)
  -> repository_dispatch resource-created (the event name PR #43 already listens for)
  -> JovieInc/ci resource-drift-scan.yml registry-create job (can-create check)
  -> Linear issue opened or reused on duplicate
Backstop: daily resource-drift-scan cron
```

Tim-reserved steps remain held: creating the GitHub org and Vercel team
webhooks, minting the dispatch token/GitHub App, setting receiver env secrets,
and deploying. The two `active_uncommissioned` entries reserve the names;
they do not claim that receivers, relays or jobs are deployed.
