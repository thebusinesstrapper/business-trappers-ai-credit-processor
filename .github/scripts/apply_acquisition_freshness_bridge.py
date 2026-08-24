from pathlib import Path

# reportFreshness.js: Round 2+ legacy rows with no baseline must not reuse an existing report.
p = Path('src/reportFreshness.js')
s = p.read_text()
old = '''    const lastUsed = memory.last_report_date_used ?? null;

    // ---- The page does not contain a report newer than the one already used --'''
new = '''    const lastUsed = memory.last_report_date_used ?? null;

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

    // ---- The page does not contain a report newer than the one already used --'''
if s.count(old) != 1:
    raise SystemExit(f'reportFreshness insertion: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# milestone6.js: mark later rounds as requiring a newer report, and bridge
# ACQUISITION_REQUIRED into the existing validated acquisition path.
p = Path('src/milestone6.js')
s = p.read_text()
old = '''        const freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: false,
        });'''
new = '''        let freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: Number(clientState?.current_round ?? 1) > 1,
        });'''
if s.count(old) != 1:
    raise SystemExit(f'milestone6 freshness memory: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)

old = '''        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
            // The Order Submitter is NOT authorized. We halt exactly where it
            // would have acted, rather than falling back to an older report.
            return successResponse({
                milestone: "M6_CAPTURE",
                result: "CAPABILITY_UNAVAILABLE",
                message:
                    "A newer report is required, but the Order Submitter is not authorized in this " +
                    "version. The processor does not fall back to an older report — analysing a stale " +
                    "report means asserting facts that may no longer be true, in the consumer's voice.",
                freshness,
                replayUrl,
            });
        }
'''
new = '''        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
            // Use the EXISTING validated $0-only acquisition path. The selector's
            // current newest report is the acquisition baseline; the path will not
            // proceed until a strictly newer report appears and will never select a
            // paid option.
            const acquisition = await runAcquisitionPath({
                chPage,
                crcClientId: client.crcClientId,
                processingRunId,
                browserbaseSessionId,
                sessionStartedMs,
                baselineReportDate,
                eligibilityHint: "ACQUISITION_REQUIRED",
                reportPageUrl: reportPage.reportUrl,
                memberDashboardUrl,
                openIntent,
                recovery,
                replayUrl,
                submitApproved: data.submitApproved === true,
                operationalRoutingApproved: data.operationalRoutingApproved === true,
                clientName: data.clientName ?? null,
                approvalTrace: data.approvalTrace,
                approvalTraceLimit: data.approvalTraceLimit,
            });
            acquisitionEvidence = acquisition.evidence ?? acquisitionEvidence;

            if (!acquisition.proceedWithCapture) return acquisition.response;

            const refreshed = await readReportSelector(chPage);
            if (!refreshed.ok) {
                return errorResponse(
                    "REPORT_SELECTOR_UNREADABLE",
                    `A fresh report was acquired but the selector could not be re-read: ${refreshed.error}`,
                    {
                        milestone: "M6_CAPTURE",
                        stage: "post_acquisition",
                        crcClientId: client.crcClientId,
                        requiresHumanReview: true,
                    }
                );
            }

            parsed = refreshed.selector;
            // Acquisition itself proved a report strictly newer than the pre-order
            // selector baseline. Re-evaluate against that grounded baseline so a
            // legacy row with no stored last_report_date_used can proceed safely.
            freshness = decideFreshness(parsed, {
                last_report_date_used: baselineReportDate,
                newer_report_required: true,
            });

            if (freshness.action !== ACTION.USE_NEWEST) {
                return errorResponse(
                    "FRESH_REPORT_NOT_VERIFIED_AFTER_ACQUISITION",
                    `Acquisition completed but freshness did not confirm the newly visible report: ${freshness.reason}`,
                    { milestone: "M6_CAPTURE", crcClientId: client.crcClientId, requiresHumanReview: true }
                );
            }
        }
'''
if s.count(old) != 1:
    raise SystemExit(f'milestone6 acquisition bridge: expected 1 match, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# Extend focused freshness test with the legacy later-round case.
p = Path('src/reportFreshness.test.js')
s = p.read_text()
append = '''\n// Later-round legacy memory with no baseline must acquire; never reuse existing.\n{\n    const selector = readSelector([{ value: "x", text: "08/24/2026" }]);\n    const result = decideFreshness(selector, { last_report_date_used: null, newer_report_required: true });\n    assert.equal(result.action, ACTION.ACQUISITION_REQUIRED);\n}\n'''
if 'Later-round legacy memory with no baseline must acquire' not in s:
    s += append
p.write_text(s)
