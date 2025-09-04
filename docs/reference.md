# reference

This file is generated from the code by `npm run commands`. Do not edit it.

## commands

### status

what is loaded and whether it holds together

### verify

walk the journal and run every integrity check

### save

write the journal and a snapshot back to the store directory

### programs

list the programs in the catalogue

### rules

the rules in force on a day

Options: --as-of <day>, --program <id>

### exceptions

everything the referral desk has to work

Options: --as-of <day>, --program <id>

### audit

walk everything that names an advocate

### reports

list the reports that can be run

### report

run one report

Options: --advocate <id>, --as-of <day>, --currency <code>, --program <id>, --shape <shape>

### report-pack

run every report in one go

Options: --advocate <id>, --program <id>, --shape <shape>

### cut

cut a settlement batch, previewing unless told to commit

Options: --as-of <day>, --commit, --currency <code>, --from <day>, --program <id>, --until <day>

### batches

list settlement batches

Options: --state <state>

### release

release a cut batch

Options: --on <day>

### pay

mark a released batch paid

Options: --on <day>

## api routes

| method | path | what it does |
| --- | --- | --- |
| get | /carriers/:invitee/touches | every touch on file for an invited carrier |
| get | /health | whether the journal still verifies and the tables still hold together |
| get | /programs | every program in the catalogue with its version count |
| get | /programs/:program | one program with every version it has had |
| get | /programs/:program/rules | the rules in force on a day, which defaults to today |
| get | /programs/:program/schedule | the reward ladder in force on a day |
| get | /referrals | referrals in a state, which the query has to name |
| get | /referrals/:program/:invitee | one referral with the days it carries |
| get | /reports | every report that can be run, with what it needs |
| get | /reports/:name | run one report and answer with it rendered in the shape asked for |
| get | /routes | every route this api answers |
| get | /settlements | batches, filtered by state when the query says so |
| post | /settlements | cut a settlement batch, or preview one with dryRun |
| get | /settlements/:batch | one batch and where it has got to |
| post | /settlements/:batch/pay | mark a released batch paid |
| post | /settlements/:batch/release | release a cut batch to accounts payable |
| post | /touches | record one referral touch through the same rules a feed row takes |

## reports

| name | what it shows | needs an advocate |
| --- | --- | --- |
| statement | one advocate, every posting, with a running balance | yes |
| performance | bounty cost against delivered margin, per advocate | no |
| exceptions | everything the referral desk has to work, oldest first | no |
| retention | invited carriers by activation month and how long they kept hauling | no |
| aging | what the program owes, by how long it has been sitting | no |
| lanes | the lanes an advocate brought in against the lanes they run | yes |
