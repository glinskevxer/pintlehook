# pintlehook

Carrier referral bounty administration for a freight brokerage.

An owner operator who already hauls for the brokerage refers another motor
carrier. The bounty is not paid on the signup. It is paid on freight the invited
carrier actually delivers, in tiers that accumulate over a rolling program year,
and it is taken back when the invited carrier churns early or when a cargo claim
is charged back.

## Running it

    npm install
    npm test
    npm run typecheck
    npm run lint

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
