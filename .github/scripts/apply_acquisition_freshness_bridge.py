from pathlib import Path
import re


def sub1(text, pattern, repl, label):
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, got {n}")
    return out

# reportFreshness.js
p = Path('src/reportFreshness.js')
s = p.read_text()
if 'later-round legacy row with no persisted report baseline' not in s:
    s = sub1(
        s,
        r'(    const lastUsed = memory\.last_report_date_used \?\? null;\n)',
        r'''\1
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
''',
        'reportFreshness legacy guard',
    )
p.write_text(s)

# milestone6.js
p = Path('src/milestone6.js')
s = p.read_text()
s = sub1(
    s,
    r'        const freshness = decideFreshness\(parsed, data\.memory \?\? \{\n            last_report_date_used: clientState\?\.last_report_date_used \?\? null,\n            newer_report_required: false,\n        \}\);',
    '''        let freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: Number(clientState?.current_round ?? 1) > 1,
        });''',
    'milestone6 freshness memory',
)

bridge = '''        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
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

s = sub1(
    s,
    r'        if \(freshness\.action === ACTION\.ACQUISITION_REQUIRED\) \{.*?\n        \}\n\n(?=        // ---- 5\. SELECT THE NEWEST)',
    bridge + '\n',
    'milestone6 acquisition bridge',
)
p.write_text(s)

# focused test
p = Path('src/reportFreshness.test.js')
s = p.read_text()
if 'later round with no baseline -> ACQUISITION_REQUIRED' not in s:
    s += '''\n// Later-round legacy memory with no baseline must acquire; never reuse existing.\n{\n    const legacySelector = readSelector([{ value: "x", text: "08/24/2026" }]);\n    const legacyResult = decideFreshness(legacySelector, { last_report_date_used: null, newer_report_required: true });\n    check("later round with no baseline -> ACQUISITION_REQUIRED", legacyResult.action, ACTION.ACQUISITION_REQUIRED);\n}\n'''
p.write_text(s)
