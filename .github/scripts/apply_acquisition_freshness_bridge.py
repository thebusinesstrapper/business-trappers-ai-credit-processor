from pathlib import Path


def replace1(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, got {n}")
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# reportFreshness.js — one-time legacy freshness floor.
# ---------------------------------------------------------------------------
p = Path('src/reportFreshness.js')
s = p.read_text()

old = '''    const lastUsed = memory.last_report_date_used ?? null;

    // A later-round legacy row with no persisted report baseline cannot prove the
    // existing selector report is new. Fail safe into the validated acquisition
    // path rather than silently reusing potentially stale evidence.
    if (memory.newer_report_required === true && !lastUsed) {
        return {
            action: ACTION.ACQUISITION_REQUIRED,
            reason:
                `This is a later dispute round but no prior successful report baseline is stored. ` +
                `The existing report (${newest.reportDate}) cannot be proven new, so a fresh free report is required.`,
            newestReportDate: newest.reportDate,
            lastReportDateUsed: null,
        };
    }
'''

new = '''    const lastUsed = memory.last_report_date_used ?? null;
    const legacyDisputeFloor = memory.legacy_dispute_date_floor ?? null;
    const validIsoDate = (value) =>
        typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}$/.test(value);

    // LEGACY BRIDGE ONLY. Some historical July cycles were delivered in CRC but
    // predate reliable persistence of last_report_date_used. We must not fabricate
    // that report date. When the prior delivery date itself is verified, however,
    // any Credit Hero report dated STRICTLY AFTER that delivery could not have
    // been the report used for the earlier cycle. It is therefore safe to use as
    // the next-round report. Same-day or older remains unproven and must acquire.
    // Once the next round succeeds, advanceRoundAfterDelivery stores the exact
    // report date used and this fallback is no longer relevant for that client.
    if (memory.newer_report_required === true && !lastUsed) {
        if (validIsoDate(legacyDisputeFloor)) {
            if (newest.reportDate > legacyDisputeFloor) {
                return {
                    action: ACTION.USE_NEWEST,
                    reason:
                        `Legacy cycle has no stored report baseline, but the newest report ` +
                        `(${newest.reportDate}) is strictly after the verified prior dispute ` +
                        `delivery date (${legacyDisputeFloor}). Use the newer report and establish ` +
                        `a real report baseline on successful delivery.`,
                    newestReportDate: newest.reportDate,
                    lastReportDateUsed: null,
                    legacyDisputeDateFloor: legacyDisputeFloor,
                    select: { value: newest.value, text: newest.text },
                };
            }

            return {
                action: ACTION.ACQUISITION_REQUIRED,
                reason:
                    `Legacy cycle has no stored report baseline, and the newest report ` +
                    `(${newest.reportDate}) is not strictly after the verified prior dispute ` +
                    `delivery date (${legacyDisputeFloor}). A fresh free report is required.`,
                newestReportDate: newest.reportDate,
                lastReportDateUsed: null,
                legacyDisputeDateFloor: legacyDisputeFloor,
            };
        }

        return {
            action: ACTION.ACQUISITION_REQUIRED,
            reason:
                `This is a later dispute round but no prior successful report baseline or verified ` +
                `legacy dispute-date floor is stored. The existing report (${newest.reportDate}) ` +
                `cannot be proven new, so a fresh free report is required.`,
            newestReportDate: newest.reportDate,
            lastReportDateUsed: null,
        };
    }
'''

s = replace1(s, old, new, 'reportFreshness legacy floor')
p.write_text(s)

# ---------------------------------------------------------------------------
# milestone6.js — pass the verified historical dispute date to freshness only
# as a legacy fallback. A real last_report_date_used always remains authoritative.
# ---------------------------------------------------------------------------
p = Path('src/milestone6.js')
s = p.read_text()
old = '''        let freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: Number(clientState?.current_round ?? 1) > 1,
        });'''
new = '''        let freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: Number(clientState?.current_round ?? 1) > 1,
            legacy_dispute_date_floor: clientState?.last_dispute_date ?? null,
        });'''
s = replace1(s, old, new, 'milestone6 legacy floor handoff')
p.write_text(s)

# ---------------------------------------------------------------------------
# reportFreshness.test.js — prove all legacy branches and make sure the final
# pass/fail summary occurs AFTER the legacy tests.
# ---------------------------------------------------------------------------
p = Path('src/reportFreshness.test.js')
s = p.read_text()
summary = '''console.log(`\\n${passed} passed, ${failed} failed.\\n`);
if (failed > 0) process.exit(1);

'''
if summary not in s:
    raise SystemExit('test summary block not found')
s = s.replace(summary, '', 1)

old_legacy = '''// Later-round legacy memory with no baseline must acquire; never reuse existing.
{
    const legacySelector = readSelector([{ value: "x", text: "08/24/2026" }]);
    const legacyResult = decideFreshness(legacySelector, { last_report_date_used: null, newer_report_required: true });
    check("later round with no baseline -> ACQUISITION_REQUIRED", legacyResult.action, ACTION.ACQUISITION_REQUIRED);
}
'''
new_legacy = '''// Later-round legacy memory with no baseline and no verified dispute floor must acquire.
{
    const legacySelector = readSelector([{ value: "x", text: "08/24/2026" }]);
    const legacyResult = decideFreshness(legacySelector, {
        last_report_date_used: null,
        newer_report_required: true,
    });
    check("legacy no baseline/floor -> ACQUISITION_REQUIRED", legacyResult.action, ACTION.ACQUISITION_REQUIRED);
}

// A verified legacy dispute date may serve as a one-time temporal floor.
// A report strictly AFTER it is necessarily newer than the prior delivered cycle.
{
    const newerLegacy = readSelector([{ value: "new", text: "08/24/2026" }]);
    const result = decideFreshness(newerLegacy, {
        last_report_date_used: null,
        newer_report_required: true,
        legacy_dispute_date_floor: "2026-07-19",
    });
    check("legacy report after dispute floor -> USE_NEWEST", result.action, ACTION.USE_NEWEST);
    check("legacy newer report selected", result.select.text, "08/24/2026");
}

{
    const sameDayLegacy = readSelector([{ value: "same", text: "07/19/2026" }]);
    const result = decideFreshness(sameDayLegacy, {
        last_report_date_used: null,
        newer_report_required: true,
        legacy_dispute_date_floor: "2026-07-19",
    });
    check("legacy same-day report -> ACQUISITION_REQUIRED", result.action, ACTION.ACQUISITION_REQUIRED);
}

{
    const olderLegacy = readSelector([{ value: "old", text: "07/18/2026" }]);
    const result = decideFreshness(olderLegacy, {
        last_report_date_used: null,
        newer_report_required: true,
        legacy_dispute_date_floor: "2026-07-19",
    });
    check("legacy older report -> ACQUISITION_REQUIRED", result.action, ACTION.ACQUISITION_REQUIRED);
}

// A real report baseline always wins; the legacy floor cannot weaken it.
{
    const realBaselineSelector = readSelector([{ value: "x", text: "08/15/2026" }]);
    const result = decideFreshness(realBaselineSelector, {
        last_report_date_used: "2026-08-15",
        newer_report_required: true,
        legacy_dispute_date_floor: "2026-07-19",
    });
    check("real baseline still blocks same report", result.action, ACTION.ACQUISITION_REQUIRED);
}

console.log(`\\n${passed} passed, ${failed} failed.\\n`);
if (failed > 0) process.exit(1);
'''
s = replace1(s, old_legacy, new_legacy, 'legacy freshness tests')
p.write_text(s)
