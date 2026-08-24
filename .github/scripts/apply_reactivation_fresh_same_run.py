from pathlib import Path

# clientMemory.js: include the prior successful report baseline in inactive enumeration.
p = Path('src/clientMemory.js')
s = p.read_text()
old = '"last_credit_hero_check_at, last_dispute_date, next_eligible_date, current_round, " +\n            "process_complete, monitoring_reactivated_date"'
new = '"last_credit_hero_check_at, last_dispute_date, next_eligible_date, current_round, " +\n            "last_report_date_used, process_complete, monitoring_reactivated_date"'
if s.count(old) != 1:
    raise SystemExit(f'clientMemory select: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# inactiveRecheckSweep.js: pass the live report date into the pure decision layer.
p = Path('src/inactiveRecheckSweep.js')
s = p.read_text()
old = '''            const decision = decideInactiveRecheck({
                storedState: client.storedState,
                observedCrcStatus: INACTIVE_CRC_STATUS,
                landing: live?.landing ?? null,
                todayIso,
            });'''
new = '''            const decision = decideInactiveRecheck({
                storedState: client.storedState,
                observedCrcStatus: INACTIVE_CRC_STATUS,
                landing: live?.landing ?? null,
                liveReportDate: live?.reportDate ?? null,
                todayIso,
            });'''
if s.count(old) != 1:
    raise SystemExit(f'inactive sweep decision call: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# inactiveRecheckDecision.js: process same run only when a strictly newer report is already present.
p = Path('src/inactiveRecheckDecision.js')
s = p.read_text()
old = '''export function decideInactiveRecheck({
    storedState = null,
    observedCrcStatus = null,
    landing = null,
    todayIso,
    cycleDays = DEFAULT_CYCLE_DAYS,
} = {}) {
    // Keep parameters in the signature for compatibility and diagnostic callers.
    void storedState;
    void observedCrcStatus;
    void todayIso;
    void cycleDays;
'''
new = '''export function decideInactiveRecheck({
    storedState = null,
    observedCrcStatus = null,
    landing = null,
    liveReportDate = null,
    todayIso,
    cycleDays = DEFAULT_CYCLE_DAYS,
} = {}) {
    // Keep legacy parameters in the signature for compatibility/diagnostics.
    void observedCrcStatus;
    void todayIso;
    void cycleDays;
'''
if s.count(old) != 1:
    raise SystemExit(f'decision signature: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)

old = '''    return {
        action: RECHECK_ACTION.REACTIVATED_WAITING,
        reason:
            "Monitoring is positively active again. Reactivation never authorizes a dispute cycle. " +
            "Route the client to Waiting For Bureau. Normal processing may resume only when Credit Hero " +
            "shows a report strictly newer than last_report_date_used from the prior successful cycle.",
        nextEligibleDate: null,
        targetCrcStatus: "Waiting For Bureau",
        waitForFreshReport: true,
    };
}'''
new = '''    const baseline = storedState?.last_report_date_used ?? null;
    const validDate = (value) => typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}$/.test(value);

    if (validDate(baseline) && validDate(liveReportDate) && liveReportDate > baseline) {
        return {
            action: RECHECK_ACTION.REACTIVATED_ELIGIBLE,
            reason:
                `Monitoring is active and Credit Hero already has a strictly newer report (${liveReportDate}) ` +
                `than the prior successful-cycle report (${baseline}). Process this client this run.`,
            waitForFreshReport: false,
        };
    }

    return {
        action: RECHECK_ACTION.REACTIVATED_WAITING,
        reason:
            validDate(baseline)
                ? "Monitoring is positively active again, but no report strictly newer than the prior successful-cycle report is available yet. Route the client to Waiting For Bureau."
                : "Monitoring is positively active again, but this legacy row has no authoritative prior report baseline. Route the client to Waiting For Bureau and do not process from an unproven report.",
        nextEligibleDate: null,
        targetCrcStatus: "Waiting For Bureau",
        waitForFreshReport: true,
    };
}'''
if s.count(old) != 1:
    raise SystemExit(f'decision active return: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# Focused pure-decision test.
Path('src/inactiveRecheckDecision.test.js').write_text('''import assert from "node:assert/strict";\nimport { decideInactiveRecheck, RECHECK_ACTION } from "./inactiveRecheckDecision.js";\nimport { CH_LANDING_STATE } from "./creditHeroLandingState.js";\n\nconst active = { state: CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD };\n\nassert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: active, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.REACTIVATED_ELIGIBLE);\nassert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: active, liveReportDate: "2026-07-02" }).action, RECHECK_ACTION.REACTIVATED_WAITING);\nassert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: null }, landing: active, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.REACTIVATED_WAITING);\nassert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: { state: CH_LANDING_STATE.PAYMENT_REQUIRED }, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.STILL_INACTIVE);\nconsole.log("inactiveRecheckDecision tests passed");\n''')
