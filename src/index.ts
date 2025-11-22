/**
 * The public surface, for anything embedding this rather than running the
 * command line.
 *
 * It is deliberately narrow. The domain rules and the store are exported
 * because a caller has to be able to ask what the program would decide, and
 * the services are exported because that is how anything is written. Nothing
 * from the command line is here: a caller that wants the terminal behaviour
 * wants the terminal.
 */

export type { Day, Instant } from './util/clock.js';
export { day, formatDay, parseDay, parseInstant } from './util/clock.js';
export type { Currency, Money } from './util/money.js';
export { formatMoney, money, parseMoney, zero } from './util/money.js';
export type { Problem, Result } from './util/result.js';
export { isErr, isOk, ok, fail, unwrap } from './util/result.js';
export type { DayInterval } from './util/interval.js';
export { interval } from './util/interval.js';

export type {
  AccrualId,
  AdvocateId,
  BatchId,
  CarrierId,
  LoadId,
  ProgramId,
} from './domain/identity.js';
export { advocateId, carrierId, programId } from './domain/identity.js';
export type { Program, ProgramRules, ProgramVersion } from './domain/program.js';
export type { RewardSchedule, Tier } from './domain/schedule.js';
export type { Party } from './domain/party.js';
export type { ReferralTouch, TouchChannel } from './domain/touch.js';
export type { Load, LoadStatus } from './domain/load.js';
export type { Accrual, AccrualKind } from './domain/accrual.js';
export type { HoldReason, HoldVerdict } from './domain/hold.js';
export type { SettlementBatch, SettlementLine } from './domain/settlement.js';
export { resolveActivation } from './domain/activation.js';
export { resolveAttribution } from './domain/attribution.js';
export { resolveQualification } from './domain/qualification.js';
export { runLadder } from './domain/ladder.js';
export { assessRetention } from './domain/retention.js';
export { assessClawback } from './domain/clawback.js';
export { assessHold } from './domain/hold.js';

export { Store } from './storage/store.js';
export { JournalLog } from './storage/log.js';
export { runIntegrity } from './storage/integrity.js';
export type { JournalDraft, JournalRecord } from './storage/journal.js';

export type { Catalog, ScheduleBinding } from './service/catalog.js';
export { buildCatalog, rulesFor, scheduleFor } from './service/catalog.js';
export type { Clock, Context } from './service/context.js';
export { contextFor, fixedClock, systemClock } from './service/context.js';
export { enrolAdvocate, fileCarrier } from './service/enrollment.js';
export { recordTouch, recordTouches } from './service/referrals.js';
export { attributeReferral } from './service/attributionService.js';
export { qualifyReferral } from './service/qualificationService.js';
export { runAccruals } from './service/accrualEngine.js';
export { cutBatch } from './service/settlementService.js';
export { runCycle } from './service/cycle.js';
export { reconcileProgram } from './service/reconciliation.js';

export { runReport, reportNames } from './report/registry.js';
export { render, type Shape } from './report/table.js';

export { buildRouter, allRoutes } from './api/app.js';
export type { ApiRequest, ApiResponse } from './api/router.js';

export const VERSION = '1.0.0';
