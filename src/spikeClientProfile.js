/**
 * spikeClientProfile.js
 *
 * CRC CLIENT PROFILE — READ-ONLY DOM DISCOVERY SPIKE.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE PERFORMS NO WRITES.
 *
 * It does not fill a field, submit a form, or press a save control. The only
 * interactions are navigation clicks on links whose VISIBLE TEXT says they open
 * the client's profile.
 *
 * ---------------------------------------------------------------------------
 * IT DISCOVERS. IT DOES NOT GUESS.
 *
 * The output is an INVENTORY plus RANKED CANDIDATES. It never concludes that a
 * given selector *is* the mailing address — it reports that four elements
 * mention "address" and shows their live values. A human makes that call.
 *
 * That distinction is the whole point. The last identity bug was not a parsing
 * error; it was a fabricated address that nothing checked. A reader that guessed
 * selectors would reproduce exactly that failure in a new costume: confidently
 * wrong about one field, printing it on a legal document sent to a credit bureau
 * in the client's name. There is no acceptable "close enough" here.
 * ---------------------------------------------------------------------------
 */

// The fields the production reader must eventually return.
const TARGET_FIELDS = [
    "firstName",
    "middleName",
    "lastName",
    "address",
    "city",
    "state",
    "zip",
    "email",
    "phone",
];

// Hints that RANK candidates for human review. Nothing here is a confirmed
// selector, and nothing here is treated as one.
const FIELD_HINTS = {
    firstName: /first[\s_-]*name|fname|given[\s_-]*name/i,
    middleName: /middle[\s_-]*name|mname|middle[\s_-]*initial|\bmi\b/i,
    lastName: /last[\s_-]*name|lname|surname|family[\s_-]*name/i,
    address: /address|street|addr/i,
    address2: /address\s*2|addr2|apt|suite|unit/i,
    city: /\bcity\b|town/i,
    state: /\bstate\b|province|region/i,
    zip: /\bzip\b|postal|postcode/i,
    email: /e-?mail/i,
    phone: /phone|mobile|cell|\btel\b/i,
    dob: /birth|\bdob\b/i,
    ssn: /\bssn\b|social[\s_-]*security/i,
};

/**
 * Inventory every input, select, and labelled text value in one frame.
 * Values are captured VERBATIM — nothing is normalised or interpreted.
 */
async function inventoryFrame(frame) {
    const hintSource = Object.fromEntries(
        Object.entries(FIELD_HINTS).map(([k, v]) => [k, { source: v.source, flags: v.flags }])
    );

    return frame.evaluate((hints) => {
        const compiled = Object.entries(hints).map(([field, re]) => [
            field,
            new RegExp(re.source, re.flags),
        ]);

        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
            );
        };

        // Best-effort label: <label for>, wrapping <label>, aria-label,
        // placeholder, or a short preceding sibling.
        const labelFor = (el) => {
            if (el.id) {
                const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (explicit?.textContent?.trim()) return explicit.textContent.trim();
            }

            const wrapping = el.closest("label");
            if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

            const aria = el.getAttribute("aria-label");
            if (aria?.trim()) return aria.trim();

            const placeholder = el.getAttribute("placeholder");
            if (placeholder?.trim()) return placeholder.trim();

            const prev = el.parentElement?.previousElementSibling;
            if (prev?.textContent?.trim() && prev.textContent.trim().length < 60) {
                return prev.textContent.trim();
            }

            return null;
        };

        const matchHints = (text) => {
            if (!text) return [];
            return compiled.filter(([, re]) => re.test(text)).map(([field]) => field);
        };

        // ---- Form controls -------------------------------------------------
        // Password fields are excluded outright. We are not reading credentials.
        const inputs = Array.from(document.querySelectorAll("input, select, textarea"))
            .filter((el) => el.type !== "hidden" && el.type !== "password")
            .map((el) => {
                const label = labelFor(el);
                const identifiers = [
                    el.id,
                    el.getAttribute("name"),
                    el.getAttribute("data-testid"),
                    label,
                ]
                    .filter(Boolean)
                    .join(" ");

                return {
                    tag: el.tagName.toLowerCase(),
                    type: el.type ?? null,
                    id: el.id || null,
                    name: el.getAttribute("name") || null,
                    testId: el.getAttribute("data-testid") || null,
                    className: typeof el.className === "string" ? el.className : null,
                    label,
                    value: el.value ?? null, // VERBATIM
                    readOnly: el.readOnly ?? false,
                    disabled: el.disabled ?? false,
                    visible: isVisible(el),
                    hintMatches: matchHints(identifiers),
                };
            });

        // ---- Read-only display values (profile rendered as text, not inputs) --
        const relevantText = Array.from(
            document.querySelectorAll("dt, dd, th, td, span, div, p, li, h1, h2, h3, h4, strong, b")
        )
            .filter((el) => el.children.length === 0) // leaf nodes only
            .filter((el) => isVisible(el))
            .map((el) => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                className: typeof el.className === "string" ? el.className : null,
                text: (el.textContent || "").trim(),
            }))
            .filter((n) => n.text.length > 0 && n.text.length < 200)
            .map((n) => ({
                ...n,
                hintMatches: matchHints(`${n.id ?? ""} ${n.className ?? ""} ${n.text}`),
            }))
            .filter((n) => n.hintMatches.length > 0);

        return {
            url: location.href,
            title: document.title,
            inputCount: inputs.length,
            inputs,
            relevantTextCount: relevantText.length,
            relevantText,
        };
    }, hintSource);
}

/**
 * Run the discovery spike against an ALREADY-OPEN client dashboard.
 *
 * @param {import('playwright').Page} page  a page sitting on the client dashboard
 * @param {object}   options
 * @param {string[]} [options.profileLinkText]  candidate link texts for the profile
 * @param {object}   [options.groundTruth]      known-correct values, for verification
 */
export async function spikeClientProfile(page, options = {}) {
    const startUrl = page.url();

    console.log("CRC CLIENT PROFILE DISCOVERY SPIKE — READ ONLY.");
    console.log("No field is filled. No form is submitted. No save control is pressed.");
    console.log(`Starting from: ${startUrl}`);

    const result = {
        readOnly: true,
        writesPerformed: 0, // INVARIANT. This module has no write path.
        startUrl,
        profileUrl: null,
        navigation: null,
        frames: [],
        fieldCandidates: {},
        groundTruthCheck: null,
        confirmationRequired: [],
        notes: [],
    };

    // ---- Reach the profile -------------------------------------------------
    //
    // We do NOT construct a URL from a pattern. We look for a navigation control
    // whose VISIBLE TEXT says it opens the profile, and report what we found. If
    // nothing matches, we say so plainly rather than inventing a path.
    const linkCandidates = options.profileLinkText ?? [
        "Client Profile",
        "Profile",
        "Client Details",
        "Client Info",
        "Personal Info",
        "Personal Information",
        "Edit Client",
        "Contact Info",
    ];

    for (const text of linkCandidates) {
        const link = page.getByText(text, { exact: false }).first();

        try {
            if (await link.count()) {
                console.log(`Candidate profile control found: "${text}". Opening (navigation only).`);

                await link.click({ timeout: 10000 });
                await page.waitForLoadState("domcontentloaded", { timeout: 20000 });

                result.navigation = { via: text, ok: true };
                break;
            }
        } catch (error) {
            result.notes.push(`Candidate "${text}" was present but did not navigate: ${error.message}`);
        }
    }

    if (!result.navigation) {
        result.notes.push(
            "No profile navigation control was found by visible text. NO URL WAS GUESSED. The " +
                "current page is still inventoried below — tell me where the profile lives in CRC and " +
                "I will point the spike at it."
        );
    }

    result.profileUrl = page.url();
    console.log(`Profile URL: ${result.profileUrl}`);

    // ---- Inventory every frame ---------------------------------------------
    //
    // CRC has already surprised us once by rendering a panel inside an iframe, so
    // we walk every frame rather than assuming the main document.
    for (const frame of page.frames()) {
        try {
            const inventory = await inventoryFrame(frame);

            if (inventory.inputCount === 0 && inventory.relevantTextCount === 0) continue;

            result.frames.push(inventory);
        } catch (error) {
            result.notes.push(`Frame not readable (detached or cross-origin): ${error.message}`);
        }
    }

    console.log(`Frames carrying profile-like fields: ${result.frames.length}`);

    // ---- Rank candidates per target field ----------------------------------
    //
    // RANKED CANDIDATES, NOT DECISIONS.
    for (const field of TARGET_FIELDS) {
        const candidates = [];

        for (const frame of result.frames) {
            for (const input of frame.inputs) {
                if (!input.hintMatches.includes(field)) continue;

                candidates.push({
                    kind: "input",
                    frameUrl: frame.url,
                    // Suggested only. A human confirms it against the live value.
                    suggestedSelector: input.id
                        ? `#${input.id}`
                        : input.name
                          ? `[name="${input.name}"]`
                          : input.testId
                            ? `[data-testid="${input.testId}"]`
                            : null,
                    id: input.id,
                    name: input.name,
                    testId: input.testId,
                    label: input.label,
                    value: input.value,
                    visible: input.visible,
                    readOnly: input.readOnly,
                });
            }

            for (const node of frame.relevantText) {
                if (!node.hintMatches.includes(field)) continue;

                candidates.push({
                    kind: "text",
                    frameUrl: frame.url,
                    tag: node.tag,
                    id: node.id,
                    className: node.className,
                    text: node.text,
                });
            }
        }

        result.fieldCandidates[field] = candidates;
    }

    // ---- Ground truth check ------------------------------------------------
    //
    // The most useful line in this output. If the real values do not appear
    // ANYWHERE in what we captured, then the selectors we are about to write
    // would be wrong — and we would not find out until a letter went to a bureau
    // with the wrong address on it.
    const groundTruth = options.groundTruth ?? null;

    if (groundTruth) {
        const haystack = JSON.stringify(result.frames).toLowerCase();

        const found = Object.fromEntries(
            Object.entries(groundTruth).map(([key, value]) => [
                key,
                typeof value === "string" ? haystack.includes(value.toLowerCase()) : null,
            ])
        );

        const missing = Object.entries(found)
            .filter(([, wasFound]) => wasFound === false)
            .map(([key]) => key);

        result.groundTruthCheck = {
            note:
                "Known-correct values for this client. Each must appear SOMEWHERE in the captured DOM. " +
                "A miss means the spike did not reach the right page, or the field renders in a way " +
                "this inventory does not see — NOT that the value is absent from CRC.",
            expected: groundTruth,
            found,
            missing,
            allFound: missing.length === 0,
        };

        if (missing.length) {
            console.log(`GROUND TRUTH MISSING FROM CAPTURE: ${missing.join(", ")}`);
        } else {
            console.log("Ground truth: every expected value appears in the captured DOM.");
        }
    }

    // ---- What a human must decide ------------------------------------------
    result.confirmationRequired = [
        "Which selector holds the CURRENT MAILING address — not a previous address, not a mailing-list address?",
        "Is the name stored as one field, or as first / middle / last?",
        "Is the profile rendered inside an iframe? (Compare frames[].url against profileUrl.)",
        "Are any fields read-only text rather than <input> values?",
        "Is the profile reachable only by clicking through, or is there a stable direct URL?",
        "Does the page carry MORE than one address block (e.g. mailing vs. previous)?",
    ];

    return result;
}
