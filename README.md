# pintlehook

Carrier referral bounty administration for a freight brokerage.

An owner operator who already hauls for the brokerage refers another motor
carrier. The bounty is not paid on the signup. It is paid on freight the invited
carrier actually delivers, in tiers that accumulate over a rolling program year,
and it is taken back when the invited carrier churns early or when a cargo claim
is charged back.

## What makes this awkward, and why it is written this way

Five rules decide what other rules measure, and none of them can be implemented
on its own.

1. **Activation dating decides the attribution window.** A carrier packet can be
   approved conditionally while insurance is outstanding. If the certificate
   lands inside the cure window the activation backdates; if it lands late it
   does not. The attribution window is measured backwards from effective
   activation, so the cure rule decides which touches are even in the running.
2. **Attribution decides tier progress.** Last touch inside the window wins,
   after a common authority screen removes touches from advocates who share an
   authority, a remit address or a bank account with the invitee. Screening a
   touch out promotes the next one, so it moves money between advocates rather
   than out of the program.
3. **Tier progress re-rates history.** Crossing a threshold re-rates every bounty
   already accrued in that program year, and the difference posts as a true up.
4. **Clawback runs the ladder backwards.** A retention failure or a charged back
   cargo claim reverses the qualifying event, which can drop the advocate below a
   threshold and produce negative true ups against bounties already paid.
5. **Holds read the settlement stream.** A batch is held on a negative position,
   an open eligibility flag, or a recovery balance over the release ceiling.
   Nothing in the hold rules mentions attribution, and yet an attribution change
   three layers up moves the held batch count.

## Running it

    npm install
    npm test
    npm run typecheck
    npm run lint
    npm run verify-tree
    npm run coverage && npm run release-check

## Using the command line

    npm start -- --store ./data --catalog ./catalog.json status
    npm start -- --store ./data --catalog ./catalog.json rules --program prg_00000001
    npm start -- --store ./data report statement --program prg_00000001 --advocate adv_00000001
    npm start -- --store ./data --catalog ./catalog.json cut \
      --program prg_00000001 --from 2025-05-01 --until 2025-06-01 --commit

`cut` previews unless you pass `--commit`. Every command and route is listed in
[docs/reference.md](docs/reference.md), which is generated from the code by
`npm run commands` and checked in CI.

## Layout

    src/util      primitives with no domain knowledge
    src/domain    the program rules, pure functions over plain values
    src/ingest    feed adapters, normalisation, dedupe, quarantine
    src/storage   append only journal, snapshots, indexed tables
    src/service   orchestration across the domain
    src/report    read models
    src/api       in process request router
    src/cli       command line front end
    tests         mirrors src, one file per module

`npm run verify-tree` fails the build on an import that runs up the layers or on
a module with no test file beside it.

## Storage

An append only journal plus periodic snapshots and a hand written indexed table.
No sqlite and nothing native, so the settlement job runs in whatever container it
is scheduled in and a settlement can be reproduced years later without a build
toolchain. Each journal record carries the digest of the one before it, so a
journal edited in the middle stops verifying at the edit rather than at the end.

## Money and clocks

Money is integer minor units end to end with a documented rounding mode per
operation. There is no floating point money anywhere. Timestamps are stored as
UTC instants and terminal local time exists only at the ingest and report
boundaries, over a daylight saving rule table this repository carries itself.

## Dependencies

`commander` and `zod`, both pinned exactly. `npm run release-check` fails if a
third one appears.
