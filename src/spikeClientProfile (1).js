/**
 * spikeClientProfile.js
 *
 * CRC CLIENT PROFILE — DOM DISCOVERY SPIKE.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY. THIS MODULE CLICKS NOTHING AND CHANGES NOTHING.
 *
 * It navigates to the client's CRC profile and INVENTORIES what is actually
 * there. It does not parse it into a client. It does not guess which field is
 * the address. It reports the DOM.
 *
 * The production reader is written AFTERWARDS, against this evidence.
 *
 * ---------------------------------------------------------------------------
 * WHY A SPIKE AND NOT JUST A READER
 *
 * The last identity bug was not a parsing error — it was a FABRICATION that
 * nothing checked. Guessing selectors here would reproduce that failure in a new
 * costume: a reader that returns *something* for every field, is confidently
 * wrong about one of them, and prints an address on a legal document sent in the
 * client's name.
 *
 * We are reading the fields that will appear, verbatim, on correspondence to a
 * credit bureau. There is no acceptable "close enough".
 * ---------------------------------------------------------------------------
 */

// The fields the production reader must return. We inventory the DOM for
// evidence of each, but we NEVER decide the mapping here — that is a human
// judgement made against the captured evidence.
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

// Labels/attributes that HINT at a field. Hints only — they rank candidates for
// human review. Nothing here is treated as a confirmed selector.
const FIELD_HINTS = {
    firstName: /first[\s_-]*name|fname/i,
    middleName: /middle[\s_-]*name|mname|middle[\s_-]*initial/i,
    lastName: /last[\s_-]*name|lname|surname/i,
    address: /address|street|addr(?![\w]*2)/i,
    address2: /address\s*2|apt|suite|unit/i,
    city: /city|town/i,
    state: /state|province|region/i,
    zip: /zip|postal/i,
    email: /e-?mail/i,
    phone: /phone|mobile|cell|tel/i,
    dob: /birth|dob/i,
    ssn: /ssn|social/i,
};

/**
 * Inventory every form field, labelled value, and input on the page, across all
 * frames. Values are captured VERBATIM.
 */
async function inventoryFrame(frame) {
    return frame.evaluate((hintSource) => {
        const hints = Object.entries(hintSource).map(([field, src]) => [field, new RegExp(src.source, src.flags)]);

        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };

        // Best-effort label for an element: <label for>, wrapping <label>,
        // aria-label, placeholder, or the nearest preceding text.
        const labelFor = (el) => {
            if (el.id) {
                const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (l?.textContent?.trim()) return l.textContent.trim();
            }

            const wrapping = el.closest("label");
            if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

            const aria = el.getAttribute("aria-label");
            if (aria?.trim()) return aria.trim();

            const ph = el.getAttribute("placeholder");
            if (ph?.trim()) return ph.trim();

            // Nearest preceding label-ish element within the same container.
            const parent = el.parentElement;
            if (parent) {
                const prev = parent.previousElementSibling;
                if (prev?.textContent?.trim() && prev.textContent.trim().length < 60) {
                    return prev.textContent.trim();
                }
            }

            return null;
        };

        const matchHints = (text) => {
            if (!text) return [];
            return hints.filter(([, re]) => re.test(text)).map(([field]) => field);
        };

        // ---- Inputs, selects, textareas -----------------------------------
        const inputs = Array.from(document.querySelectorAll("input, select, textarea"))
            .filter((el) => el.type !== "hidden" && el.type !== "password")
            .map((el) => {
                const label = labelFor(el);
                const identifiers = [el.id, el.name, el.getAttribute("data-testid"), label]
                    .filter(Boolean)
                    .join(" ");

                return {
                    tag: el.tagName.toLowerCase(),
                    type: el.type ?? null,
                    id: el.id || null,
                    name: el.getAttribute("name") || null,
                    testId: el.getAttribute("data-testid") || null,
                    label,
                    value: el.value ?? null,       // VERBATIM
                    readOnly: el.readOnly ?? false,
                    disabled: el.disabled ?? false,
                    visible: visible(el),
                    hintMatches: matchHints(identifiers),
                };
            });

        // ---- Read-only "display" values (profile shown as text, not inputs) --
        const textNodes = Array.from(document.querySelectorAll("dt, dd, th, td, label, span, div, p, h1, h2, h3"))
            .filter((el) => visible(el))
            .filter((el) => el.children.length === 0) // leaf nodes only
            .map((el) => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                className: typeof el.className === "string" ? el.className : null,
                text: (el.textContent || "").trim(),
            }))
            .filter((n) => n.text && n.text.length < 200);

        // Only keep text nodes that look like they carry, or label, our fields.
        const relevantText = textNodes
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
            relevantText,
        };
    }, Object.fromEntries(Object.entries(FIELD_HINTS).map(([k, v]) => [k, { source: v.source, flags: v.flags }])));
}

/**
 * Run the discovery spike against an OPEN client dashboard.
 *
 * @param {import('playwright').Page} page   a page already on the client dashboard
 * @param {object} options
 * @param {string[]} [options.profileLinkText]  link text candidates to reach the profile
 */
export async function spikeClientProfile(page, options = {}) {
    const startUrl = page.url();

    console.log("CRC PROFILE DISCOVERY SPIKE — READ ONLY. Nothing is clicked that changes state.");
    console.log(`Starting from: ${startUrl}`);

    const result = {
        ok: false,
        startUrl,
        profileUrl: null,
        navigation: null,
        frames: [],
        fieldCandidates: {},
        notes: [],
    };

    // ---- Reach the profile -------------------------------------------------
    //
    // We do NOT guess a URL. We look for a navigation control whose visible text
    // says it goes to the client's profile/details, and report what we find. If
    // we cannot find one, we say so — and the human tells us where it is.
    const linkCandidates = options.profileLinkText ?? [
        "Client Profile",
        "Profile",
        "Client Details",
        "Edit Client",
        "Personal Info",
        "Client Info",
    ];

    let navigated = false;

    for (const text of linkCandidates) {
        const link = page.getByText(text, { exact: false }).first();

        try {
            if (await link.count()) {
                console.log(`Found a candidate profile control: "${text}". Opening it (navigation only).`);
                await link.click({ timeout: 10000 });
                await page.waitForLoadState("domcontentloaded", { timeout: 20000 });

                result.navigation = { via: text, ok: true };
                navigated = true;
                break;
            }
        } catch (error) {
            result.notes.push(`Candidate "${text}" found but did not navigate: ${error.message}`);
        }
    }

    if (!navigated) {
        result.notes.push(
            "Could not locate a profile navigation control by visible text. NO URL WAS GUESSED. " +
            "Report where the client profile lives in CRC and this spike will be pointed at it."
        );
    }

    result.profileUrl = page.url();

    console.log(`Profile URL: ${result.profileUrl}`);

    // ---- Inventory every frame ---------------------------------------------
    for (const frame of page.frames()) {
        try {
            const inventory = await inventoryFrame(frame);

            if (inventory.inputCount === 0 && inventory.relevantText.length === 0) continue;

            result.frames.push({
                url: inventory.url,
                title: inventory.title,
                inputCount: inventory.inputCount,
                inputs: inventory.inputs,
                relevantText: inventory.relevantText,
            });
        } catch (error) {
            result.notes.push(`Frame not readable: ${error.message}`);
        }
    }

    // ---- Rank candidates per target field ----------------------------------
    //
    // RANKED CANDIDATES, NOT DECISIONS. This tells a human "these four elements
    // mention 'address'". It does not tell them which one is the mailing address.
    // That call is made by a person looking at real values.
    for (const field of TARGET_FIELDS) {
        const candidates = [];

        for (const frame of result.frames) {
            for (const input of frame.inputs) {
                if (input.hintMatches.includes(field)) {
                    candidates.push({
                        kind: "input",
                        frameUrl: frame.url,
                        selector: input.id
                            ? `#${input.id}`
                            : input.name
                              ? `[name="${input.name}"]`
                              : null,
                        id: input.id,
                        name: input.name,
                        label: input.label,
                        value: input.value, // VERBATIM — the human confirms this is right
                        visible: input.visible,
                    });
                }
            }

            for (const node of frame.relevantText) {
                if (node.hintMatches.includes(field)) {
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
        }

        result.fieldCandidates[field] = candidates;
    }

    result.ok = result.frames.length > 0;

    if (!result.ok) {
        result.notes.push("No readable frames carried profile-like fields. Nothing was inferred.");
    }

    // ---- What the human needs to confirm -----------------------------------
    result.confirmationRequired = [
        "Which selector is the MAILING address (not a previous address, not a mailing-list address)?",
        "Is the name stored as one field or as first/middle/last?",
        "Is the profile rendered in an iframe? (Check frames[].url above.)",
        "Do any fields render as read-only text rather than inputs?",
        "Does the profile page require navigation from the dashboard, or a direct URL?",
    ];

    result.expectedForClient15 = {
        note: "GROUND TRUTH for CRC Client ID 15, supplied by Business Trappers. The spike output " +
              "MUST contain these exact values, or the selectors are wrong.",
        name: "Elizabeth Suzanne Kelley",
        address: "5084 Louvinia Dr",
        city: "Tallahassee",
        state: "FL",
        zip: "32311",
    };

    return result;
}
