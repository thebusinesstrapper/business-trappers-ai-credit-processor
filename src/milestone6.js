/**
 * milestone6.js
 *
 * REAL REPORT CAPTURE — GOALS 1 THROUGH 3 ONLY.
 *
 * ===========================================================================
 * WHAT THIS DOES:
 *
 *   1. Read the verified CRC client profile      (FROZEN — Identity Source Standard)
 *   2. Open Credit Hero                          (M3)
 *   3. Read the report selector                  (Report Selector Authority §1.2)
 *   4. Select the NEWEST report
 *   5. VERIFY the selected report is genuinely ACTIVE before reading anything
 *   6. Passively capture the Array.io MISMO JSON
 *   7. Return the RAW payload and a STRUCTURAL INVENTORY
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *   - Normalize. There is no BT Credit Report Model™ built here.
 *   - Reconcile.
 *   - Generate letters.
 *
 * ===========================================================================
 * WHY IT STOPS AT RAW.
 *
 * The Extraction System §10 is binding: NO SELECTORS ARE GUESSED, NO PARSER IS
 * WRITTEN UNTIL THE REAL STRUCTURE IS KNOWN.
 *
 * Nobody has yet seen the real Array.io MISMO payload for this client. A parser
 * written against an imagined schema would not fail loudly — it would return
 * `null` for every field it guessed wrong, and §6.1 of the Extraction System
 * says exactly what happens next: the Intelligence Engine detects deletions BY
 * ABSENCE, so tradelines we merely failed to parse become **fabricated
 * deletions**, which flow into strategy and then into a letter.
 *
 * So this run produces EVIDENCE, not a model. The normalizer is written against
 * what comes back — exactly as the Milestone 4 eligibility engine was.
 *
 * THE ONE THING THIS RUN MUST NEVER DO: click anything that could cost the
 * client money. The report page carries order and reactivation controls. This
 * run reads. It does not act.
 * ===========================================================================
 */

import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { readClientProfile } from "./crcClientProfile.js";
import { verifyIdentity } from "./intelligence/clientIdentity.js";
import { openCreditHero } from "./openCreditHero.js";
import { readReportSelector, selectReport, verifyActiveReport } from "./reportSelector.js";
import { decideFreshness, ACTION } from "./reportFreshness.js";
import { analyzeReportShape, buildSkeleton } from "./spikeReportJson.js";

export async function runMilestone6(data = {}) {
    let browser;

    try {
        const clientName = data.clientName || "Elizabeth Kelley";

        const session = await launchBrowser();
        browser = session.browser;

        const page = session.page;
        const replayUrl = `https://www.browserbase.com/sessions/${session.session.id}`;

        console.log(`Browserbase replay: ${replayUrl}`);

        // ---- 1. IDENTITY (frozen, authoritative) ---------------------------
        await loginToCRC(page);

        const client = await openClient(page, clientName);

        if (!client.clientFound || !client.clientOpened) {
            return errorResponse("CLIENT_NOT_OPENED", `Could not open client "${clientName}".`);
        }

        const profile = await readClientProfile(page, client.crcClientId);

        if (!profile.ok) {
            return errorResponse(
                profile.error_code,
                `Identity could not be established: ${profile.error} ` +
                    `Extraction does not proceed without a verified CRC identity.`
            );
        }

        const identityCheck = verifyIdentity(profile.identity);

        if (!identityCheck.ok) {
            return errorResponse(
                "IDENTITY_VERIFICATION_FAILED",
                `The CRC profile was read but did not pass verification: ${identityCheck.errors.join(" ")}`
            );
        }

        console.log(`Identity verified: ${profile.identity.name} (CRC ${client.crcClientId})`);

        // ---- 2. ATTACH THE PASSIVE LISTENER *BEFORE* NAVIGATING ------------
        //
        // This is a response listener. It catches what the page fetches AS the
        // page fetches it. Attached after the report has loaded, it catches
        // nothing at all — and would report "no payload found" on a page that had
        // already delivered one.
        //
        // Retains the FULL parsed payload, not just a skeleton: the Normalization
        // Engine has to be written against the real structure, and a skeleton
        // tells us the shape without giving us a fixture to test against.
        const captured = capturePayloads(page);

        // ---- 3. CREDIT HERO ------------------------------------------------
        const creditHero = await openCreditHero(page);

        if (!creditHero.ok) {
            return errorResponse(
                creditHero.error_code ?? "CREDIT_HERO_UNAVAILABLE",
                creditHero.error ?? "Could not open Credit Hero."
            );
        }

        // ---- 4. THE REPORT SELECTOR IS AUTHORITATIVE FOR FRESHNESS ---------
        //
        // Not the CRC timer, not the order page, not elapsed time. Those describe
        // when a report BECOMES ORDERABLE. The selector enumerates WHAT EXISTS.
        // Freshness is READ, never INFERRED.
        const selector = await readReportSelector(page);

        if (!selector.ok) {
            return errorResponse(
                "REPORT_SELECTOR_UNREADABLE",
                `Could not read the report selector: ${selector.error}. Freshness is read from the ` +
                    `selector and never inferred, so this is a hard stop.`
            );
        }

        const parsed = selector.selector; // { reports, rejected, newest, count }

        console.log(`Report selector: ${parsed.count} report(s) positively identified.`);
        parsed.reports.forEach((r) => console.log(`  - ${r.text} -> ${r.reportDate}`));

        if (parsed.rejected.length) {
            console.log(`  ${parsed.rejected.length} option(s) rejected as not-a-report:`);
            parsed.rejected.forEach((r) => console.log(`    - "${r.text}" (${r.reason})`));
        }

        // decideFreshness takes TWO positional arguments: (selector, memory).
        // Passing a single object leaves `newest` and `count` undefined, which
        // resolves to MANUAL_REVIEW — a fail-closed default that would halt every
        // run on every client while looking like a legitimate refusal.
        const freshness = decideFreshness(parsed, data.memory ?? {});

        console.log(`Freshness decision: ${freshness.action} — ${freshness.reason}`);

        if (freshness.action === ACTION.MANUAL_REVIEW) {
            return errorResponse("FRESHNESS_MANUAL_REVIEW", freshness.reason);
        }

        // NO_ACTION_REQUIRED means memory has already analyzed this report. That is
        // a decision about whether a DISPUTE CYCLE is due — not about whether we may
        // read the report. This milestone is capture only, so we proceed.
        if (freshness.action === ACTION.NO_ACTION_REQUIRED) {
            console.log("Memory has seen this report before. Capturing anyway — this run is capture-only.");
        }

        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
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

        // ---- 5. SELECT THE NEWEST ------------------------------------------
        //
        // freshness.select is { value, text } — the shape selectReport() expects.
        const target = freshness.select;

        if (!target) {
            return errorResponse(
                "NO_REPORT_SELECTED",
                `Freshness returned ${freshness.action} but supplied no report to select. ${freshness.reason}`
            );
        }

        console.log(`Selecting newest report: ${target.text} (${freshness.newestReportDate})`);

        const selected = await selectReport(page, target);

        if (!selected.ok) {
            return errorResponse("REPORT_SELECT_FAILED", selected.error);
        }

        // ---- 6. VERIFY IT IS GENUINELY ACTIVE ------------------------------
        //
        // selectOption() returning proves only that Playwright set the value —
        // NOT that the app reacted. If Credit Hero swallowed the change event we
        // would parse the OLD report while believing it was the new one, and every
        // downstream fact would be wrong with no error anywhere.
        const active = await verifyActiveReport(page, target);

        if (!active.ok) {
            return errorResponse(
                "REPORT_NOT_VERIFIED_ACTIVE",
                `The report was selected but could not be VERIFIED as active: ${active.error}. ` +
                    `Extraction is gated on verified activation — we do not parse a report we cannot ` +
                    `confirm is the one on screen.`
            );
        }

        console.log(`VERIFIED ACTIVE: ${target.text}`);

        // ---- 7. LET THE SELECTED REPORT'S PAYLOAD ARRIVE --------------------
        //
        // Selecting a report triggers a fresh fetch. The listener is already
        // attached, so we just give the network time to deliver it.
        //
        // READ ONLY throughout. The report page carries controls that order
        // reports and reactivate monitoring. Nothing here clicks any of them.
        await page.waitForTimeout(5000);

        const reportPayloads = captured.filter((c) => c.looksLikeCreditReport);

        if (reportPayloads.length === 0) {
            return errorResponse(
                "NO_REPORT_PAYLOAD_CAPTURED",
                `Captured ${captured.length} JSON response(s), but none looks like a credit report ` +
                    `(none carried tradeline/bureau/liability structure). The Normalization Engine is ` +
                    `NOT written against a guess — this run returns what it saw so the real payload can ` +
                    `be identified. Candidates: ` +
                    captured.map((c) => `${c.url.slice(0, 80)} [${c.topLevelKeys?.join(",") ?? "?"}]`).join(" | ")
            );
        }

        // The largest report-shaped payload is the report. Stated, not assumed —
        // and every candidate is returned so this can be checked rather than trusted.
        const report = reportPayloads.sort((a, b) => b.size - a.size)[0];

        console.log(`Captured report payload: ${report.url.slice(0, 100)} (${report.size} bytes)`);

        return successResponse({
            milestone: "M6_CAPTURE",
            result: "CAPTURED",

            crcClientId: client.crcClientId,
            identity: profile.identity,
            identityVerified: true,

            reportSelected: {
                text: target.text,
                date: freshness.newestReportDate,
                verifiedActive: true,
            },

            selectorOptions: parsed.reports.map((r) => ({ text: r.text, date: r.reportDate })),
            selectorRejected: parsed.rejected,
            freshness: { action: freshness.action, reason: freshness.reason },

            // THE EVIDENCE. This is what the normalizer gets written against.
            capturedPayload: {
                url: report.url,
                size: report.size,
                topLevelKeys: report.topLevelKeys,
                analysis: report.analysis,
                skeleton: report.skeleton,
            },

            // Every JSON response seen, so the choice above can be CHECKED rather
            // than trusted. If the wrong one was picked, this shows it.
            allJsonResponses: captured.map((c) => ({
                url: c.url,
                size: c.size,
                topLevelKeys: c.topLevelKeys,
                looksLikeCreditReport: c.looksLikeCreditReport,
            })),

            // The full payload — so the Normalization Engine can be built and
            // unit-tested against a REAL fixture, with no browser and no credentials.
            payload: report.payload,

            normalized: false,   // INVARIANT for this milestone
            reconciled: false,   // INVARIANT for this milestone
            lettersGenerated: 0, // INVARIANT for this milestone

            message:
                "Report captured and verified active. NOT normalized, NOT reconciled, NO letters. " +
                "The Normalization Engine is written against this payload — never against a guessed " +
                "schema.",

            replayUrl,
        });

    } catch (error) {
        console.error("Milestone 6 failed:", error);
        return errorResponse("MILESTONE_6_ERROR", error.message);

    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Passive JSON capture. Attach BEFORE navigating.
 *
 * Retains the FULL parsed payload — unlike the spike's capture, which keeps only
 * a skeleton. A skeleton tells us the shape; it does not give us a fixture the
 * Normalization Engine can be unit-tested against without a browser.
 *
 * PURELY PASSIVE. It observes responses. It never issues a request, never clicks,
 * and cannot affect the page.
 */
function capturePayloads(page) {
    const captured = [];

    page.on("response", async (response) => {
        try {
            const url = response.url();
            const contentType = (response.headers()["content-type"] || "").toLowerCase();

            if (!contentType.includes("json") && !/json/i.test(url)) return;

            const body = await response.text().catch(() => null);
            if (!body) return;

            let payload;
            try {
                payload = JSON.parse(body);
            } catch {
                return; // not JSON after all
            }

            const topLevelKeys = payload && typeof payload === "object" ? Object.keys(payload) : [];

            captured.push({
                url,
                size: body.length,
                topLevelKeys,
                looksLikeCreditReport: looksLikeCreditReport(body),
                analysis: analyzeReportShape(payload),
                skeleton: buildSkeleton(payload),
                payload, // THE FIXTURE
            });

            console.log(`JSON captured: ${url.slice(0, 100)} (${body.length} bytes)`);
        } catch {
            // A response can be gone before we read it. Capture must never break
            // the run.
        }
    });

    return captured;
}

/**
 * Does this payload look like a credit report?
 *
 * A HEURISTIC, and named as one. It is used only to CHOOSE which captured payload
 * to surface first — every candidate is returned regardless, so a wrong choice is
 * visible rather than silent. Nothing is parsed on the strength of this.
 */
function looksLikeCreditReport(body) {
    const markers = [
        /tradeline/i,
        /creditliability/i,
        /credit_?liability/i,
        /transunion/i,
        /experian/i,
        /equifax/i,
        /CREDIT_RESPONSE/i,
        /inquiry/i,
    ];

    const hits = markers.filter((m) => m.test(body)).length;

    // Two or more independent markers. One could be incidental.
    return hits >= 2;
}
