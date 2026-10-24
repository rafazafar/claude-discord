# Delivery standards (AI-first)

How the team builds and runs projects. The estimate assumes these by default; they are what let AI loop on its own and keep human hours low. Drop one only when a requirement rules it out, and say so (it raises the hours - use the manual sizing units).

## Principle

Bias towards meaningful automation that cuts human effort and calendar time, as long as it is reasonable and breaks no requirement (security, data location, cost target, client constraints). If a choice adds a little build effort but removes recurring human review or waiting, take it.

## Architecture

- **Fewest deployables.** Prefer one app (e.g. one serverless function serving pages and API) over several services. No VPC, servers or containers unless a requirement needs them.
- **Serverless, no fixed cost** where the volume allows.
- **No API keys or secrets.** Use the platform's roles for DB, mail, SMS. Each extra vendor with a key needs a reason.
- **Stay inside one platform first**, verify early (e.g. SMS delivery on real phones in week 1), and keep a cheap fallback to an outside vendor.
- **Say why not** for the obvious heavier alternatives (e.g. RDS/VPC, Amplify/SST, a second IaC tool).

## IaC and environments

- IaC in the app's language and repo (e.g. AWS CDK in TypeScript). Least-privilege permissions, no wildcards.
- **One input: the stage name.** Everything else comes from the stage or a config file in the repo. No `.env`.
- **Two stacks:** shared (once per account: domain, mail domain auth, CI trust, budget alert) and app-per-stage.
- **Three commands:** `up` / `test` / `down` for a stage.
- **Temporary environment per PR**, created on PR open and deleted on close. Light: no CDN/custom domain, short log retention, fully deletable.
- **Production can't be destroyed:** deletion protection and retain on DB and user pool.
- CI with keyless auth (e.g. GitHub OIDC). Production deploy needs a human approval.
- Budget alert on the account.

## Automated tests (the reason human review stays small)

Run on every PR environment, a few minutes each:
- The main user flow end to end.
- **Concurrency:** many simultaneous requests against a limit, only the allowed number succeed.
- **Time:** an injectable clock in non-production, so deadlines, reminders and deletion jobs are tested without waiting.
- Permissions per role, login (generate 2FA codes in the test), "can't call admin API without login".
- Scheduled jobs triggered manually and checked.
- **Test-mode senders:** mail to the provider's test inbox, SMS logged instead of sent.
- Restore drill script before delivery.

## Platform onboarding (lead times - put them in blockers and delay risks)

| Item | Note |
|---|---|
| Account ownership | Client-owned (client work + waiting) or created in our organization and billed, transferable later (we become the operator and data processor - write it in the contract) |
| Access for us | A one-click role/link the client runs; no shared passwords |
| IaC bootstrap and CI trust | Once per account |
| Mail sending approval | e.g. AWS SES sandbox removal: 1–2 days, can be rejected - describe the transactional use |
| SMS limits | e.g. new AWS accounts start with a tiny monthly SMS spend limit - request an increase |
| Domain / DNS records | Who can edit the client's DNS |
| Budget alert | Set on day 1 |

Dev and PR environments can start in our own account while the production account is prepared.
