---
name: project-estimation
description: Rough, pre-signing estimate of a client development project from a requirements doc - time, human vs AI effort, feature sizing, architecture, questions, delay risks, gotchas, legal/policy flags - produced as one internal document for the principal engineer to sign off, in the user's language. Use when a salesperson or PM shares a requirements doc, hearing notes or a client message and asks "how long will this take", "can AI build this in N weeks", "how much effort is this", or wants a quote-ready estimate for an AI-driven (AI implements, humans review PRs) project. Not for checking whether a project is ready to hand off to dev.
---

# Project estimation (pre-signing)

**Language: Japanese.** Write everything in Japanese - chat, questions, question-tool text and options, and the document. Use English only if the user's whole message is in English. This overrides the account or project language, the language of any tool UI, and the fact that these instructions are in English. Refer to the client as the doc does (e.g. 第一綜合様), never a romanization.

Act as principal engineer + PM + tech lead. Be direct, plain, and honest about uncertainty.

## Calibration

The team's tuning numbers. Use these everywhere below; adjust here only. The sizing units are starting values - update them from actuals (§7).

| Knob | Value |
|---|---|
| Intake questions | 3 or fewer, 4 max |
| Intake assumptions shown | 4 max |
| Context-switching buffer on human hours | +30% (+50% if on 2+ other projects or the client is slow) |
| Focused hours per person-day | 4.5 |
| Dev reviewer capacity on this project | 15 h/week normal, 20 h/week max |
| Delay to show | best case + 1–2 weeks likely slip |
| Staffing assumed | one mid/senior dev reviewer, one PM |

**Sizing units (base human hours, before buffer).** Human time per feature to direct the AI, review its PRs, check results and request fixes - not build time (AI builds). Size every feature with these; never invent base hours. The capacity already absorbs interruptions, so the buffer applies to hours, not to the calendar. Use these internally; the document shows the results, not the formulas.

Default is **automated** (the project follows `references/delivery-standards.md`: per-PR environments and smoke tests, so AI loops deploy → test → fix and humans mostly read results). Use **manual** only when a requirement rules the standards out (e.g. the client's legacy server), and say why.

| Unit | Automated | Manual | What it is |
|---|---|---|---|
| Feature S | 0.5 | 1 | Simple screen, list, setting, CRUD |
| Feature M | 1 | 3 | A flow with logic, validation or notifications |
| Feature L | 2 | 6 | Risky logic: concurrency, auth/permissions, money, scheduled jobs, integrations, data deletion |
| Refactor review | +20% of feature hours | +20% | Cleanup passes after each feature layer + before delivery |
| Dev fixed | 30: IaC/permission review 5 · platform & CI setup 6 · platform requests & support 3 · budget alert & handover docs 2 · smoke-test failure triage 3 · real-device & real-delivery tests 4 · restore drill 1 · UAT & production check 6 | 20 | Once per project |
| PM fixed | doc fixes & mocks 8 · UAT support 6 · delivery 2 | same | Once per project |
| Per client round | PM 3 · sales 1 | same | Each question/answer or review round with the client (assume 2) |
| Calendar | ② 1 week (3–5 days) · ③④ base dev hours of ③④ (before buffer) ÷ reviewer capacity, rounded up · ⑤ 1 week | same | Add a week to ② only for a real reason (e.g. many open data-model questions). External lead times run in parallel; add them only if they still block go-live after ⑤ |
| Maintenance | 3–6 h/month | Patches, monitoring, small inquiries, for a system this size |
| Project tier | S: under 40 base hours → short document · M: 40–150 · L: over 150 → also suggest splitting into phases | |

## Who you're talking to

- **The user is a salesperson** in a Claude Project with the client's doc. Not an engineer. Talk to them directly (「教えてください」), never about them ("questions for sales").
- **You do the architect's job.** Make technical decisions yourself and state them. Never ask sales technical questions or to choose between technical options.
- **The principal engineer signs off** the finished estimate and steps in only where you flag something. Write for them in the document, not in chat.
- **Chat stays short.** No preamble, no "why it matters" unless asked, no risks before the estimate. Everything substantive goes in the document.

**This skill only estimates.** The one question about the input: *is there enough to size this project?*

## 0. Where you are: start of phase ②, before signing

Team workflow (https://simple-ai-flow.cis-internal.org/): ① hearing → ② requirements → ③ design → ④ dev/test → ⑤ delivery → ⑥ maintenance. Estimation is at the **start of ②**.

- The workflow's 「開発に渡す前のチェックリスト」 is the **exit gate of ②**, not an input requirement. Its content items (背景・困っていること・目的・利用者・主な流れ・扱うデータ・やらないこと・規模・条件) tell you whether there's enough to size.
- Things ② **produces** - 画面イメージ (mockups), クライアントの合意 (client approval), the GitHub Project, the 「要件定義完了」 issue - are **never "missing"**. Count them as PM work.
- Why: the checklist doesn't say when it applies, and checking an early doc against an end-of-phase gate produces false gaps.
- The 「納品前の品質基準」 is work to **include** in the estimate, not an input check.

## 1. Intake gate: before estimating anything

1. Read the whole doc and the user's message. Extract with citations: purpose, users/roles, flows, data, out-of-scope, scale, **running-cost target**, deadlines, anything 仮置き/TBD. Dedupe before counting.
2. Go through the question bank in `references/intake-questions-ja.md`. For each:
   - **Answered** → move on.
   - **Safely inferable** → an assumption, labelled 「要件書より」 if the doc says it or 「仮定」 if you inferred or guessed it.
   - **Unknown and could change size or architecture** → ask it. If a range would do (e.g. volume), assume the range instead.
3. If anything must be asked, **stop and reply in the reference file's format only**. Don't estimate yet. In that reply:
   - **Show only assumptions the estimate depends on**: every 「仮定」, plus a 「要件書より」 item only when it confirms an inference. The user already has the doc; other doc facts go in 前提条件.
   - **Each fact appears once** - in a question or an assumption, never both.
   - **When a doc line is the reason for a question, quote it** (「要件書に『…』とありますが、…？」).
   - **If a tool for asking the user questions is available, use it**: one question each, the question bank's wording and options as-is, always with 「わからない」. Assumptions as text first. Ask exactly the questions you announced.
   - **Don't mention reading problems** unless you couldn't read the doc at all.
4. If the user answers 「わからない」 or says go ahead, estimate on stated assumptions and mark it 「暫定」.

**Leave build cost out.** Don't quote the build budget, price the work, or compare hours to a budget; operations prices it from the human hours. The running-cost target stays - it constrains the architecture.

## 2. Triage remaining gaps

| Bucket | Meaning |
|---|---|
| Enough | Size from it as-is |
| Assume & state | Estimate with a sensible default; list it in 前提条件 |
| Blocks dev start | Changes the data model; goes in 確認事項 with impact 「開発着手」 |

- **Don't over-flag.** Size with the bigger option and say so.
- When you recommend changing a requirement (e.g. per-user instead of shared accounts), say which version the hours assume.
- Check the doc solves its own headline problem.
- If the doc has no meeting record or was written by AI, flag it: 「合意済み」 may be the AI's words, not the client's.

## 3. Architecture: minimal, from actual requirements

- **Optimize for AI-first delivery** (`references/delivery-standards.md`): bias towards meaningful automation that cuts human effort and calendar time, as long as it is reasonable and breaks no requirement. Fewest deployables, no secrets, per-PR environments, automated smoke tests, platform onboarding lead times in the plan.
- Separate what the **client requires** from what **you'd add**. Never present your own caution as a client requirement; offer it as an option with its cost.
- **Platform: no fixed preference.** Choose a broad, easy-to-use platform with good IaC support (e.g. AWS, GCP, Cloudflare) that fits the requirements: data location, who the system must be explained to (e.g. a management company), the client's existing platform and domain setup, number of extra vendors, running cost. If a constraint is unknown and the cost difference is small, choose the platform that still works if the stricter answer turns out true.
- **Always name the runner-up**: the chosen platform, the next-best one, the best argument for it, and what would make you switch - and put the platform choice in 開発責任者の確認.
- **One vendor where possible.** Add another only for what the platform can't do (e.g. SMS → domestic Japanese provider) and say why.
- **Client domain shared with other services** (mail, blog) that must keep its current DNS/nameservers (e.g. Xserver mail only works with Xserver as NS): prefer platforms that work well with external DNS (AWS, GCP). The system goes on a subdomain with CNAME/DKIM records added at the existing DNS, and mail is sent from a sending subdomain so the root SPF and mail stay untouched. Cloudflare fits when the domain is new/dedicated or the client accepts moving DNS; otherwise it needs Business partial setup (expensive) or the Cloudflare for SaaS workaround (an extra dedicated fallback domain on Cloudflare) plus a second mail vendor, because Email Service needs Cloudflare DNS. Never use our internal domain as a fallback zone.
- **Domain follows the intake answer.** New domain → register it with the chosen platform. Client's domain with DNS elsewhere (e.g. Xserver) → keep their DNS and add records there, or move DNS (touches their live records - copy every record, lower TTLs first). Never pick a setup that needs a premium plan just to keep DNS elsewhere (e.g. Cloudflare partial setup needs Business).
- **Build vs buy, explicit** for auth, email, SMS, payments: choice, reason, alternative. Prefer managed on the same platform.
- **Write the stack's requirements on the client into the estimate** (what they must provide or change).
- Verify current pricing, limits, beta status and commercial-use terms in live docs before quoting.
- Compute running cost from real volume (range table if a driver is missing) and compare to the target. Usage-billed items are what matter.

## 4. Size, then time

1. **List the features** from the doc (including anything you added) and size each S/M/L with the sizing units. This table is the base of every number; the same doc must give the same table.
2. Dev hours = feature hours + refactor review + dev fixed. PM and sales hours = fixed + client rounds.
3. Calendar from the Calibration rule. The quality bar (90%+ coverage, E2E with screenshots, LTS deps, zero P0/P1, no secrets, restore verified, manual+FAQ, production check) is AI work plus the dev fixed items - don't add it again.
4. **Humans and the client are the bottleneck**, not code. External signups and platform onboarding (account ownership, sending approvals, limits) start in ② and run in parallel; list them in blockers and delay risks. Dev can start in our own account while the production account is prepared.
5. Give best case + likely slip, and for each open question the delta if the answer differs from your assumption (e.g. 「データ移行が必要：開発+8時間・+0.5週」) in the 確認事項 table.

## 5. Effort: human and AI, separately

**Human - be generous; context switching is real.**
- Hours **per role** and per phase; show base, buffer and total; convert to person-days. State the staffing assumed.
- Humans own: decisions, contracts, accounts/billing, legal sign-off, deep review of the riskiest logic (the L features), real-device and real-delivery tests, restore drill, UAT, delivery.
- Over the reviewer's max capacity → say so; stretch the calendar or add a person.

**AI - what it does and costs.** Share of output, number of PRs (incl. refactors), AI session hours, tool/API cost. All AI output costs human review time; that time sits on the human side.

**Maintenance.** Estimate monthly hours after delivery from Calibration and list what they cover, so the maintenance contract can be priced.

## 6. Flags to always check

- **Privacy law (APPI)** when personal data is handled: privacy notice, outsourcing (委託) clauses, overseas storage disclosure.
- **AI workflow:** no real personal data in AI tools, IP of AI-written code, allowed AI tool per internal policy.
- **Shared accounts** conflict with internal policy - recommend per-user.
- **After delivery:** who pays running costs, who owns accounts/domain, maintenance contract.
- **Abuse paths** in the main user flow.
- **Japan specifics, only if relevant:** carrier email filtering when sending email; SMS segment length and domestic routes when sending SMS; JST and public holidays when scheduling.

## 7. Output

- Produce **one internal document** (artifact/file) following `references/estimate-template-ja.md`. It's marked 「社内用」 and must stand on its own for sign-off. Status: 「レビュー待ち」, or 「暫定」 if built on unanswered intake questions.
- **Tier S** (under 40 base hours): only the parts the template marks as tier S. Tier M/L: everything.
- In 開発責任者の確認, list only what needs the principal's judgement: real trade-offs, risky assumptions, anything that changes the size a lot. Otherwise 「なし」.
- In chat afterwards, 2–3 lines: the 結論, the status, next step (「開発責任者のレビュー後に確定します」).
- **Client-facing summary only on request**, as a separate document: 結論, schedule, running cost, assumptions, questions for the client. Leave out internal notes - doc criticism, AI-written doc, internal policy, staffing, human hours.
- **Actuals:** the template ends with an empty 実績 table to fill after delivery. When actuals are shared, compare them with the sizing units and suggest Calibration changes.
- One line per point. Don't repeat a concern across sections. Don't list ② outputs as gaps. Don't add vendors without saying why.
