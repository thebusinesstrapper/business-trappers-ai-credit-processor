export function successResponse(data = {}) {
    return {
        success: true,
        milestone: "M1_CLIENT_ACCESS",
        timestamp: new Date().toISOString(),
        ...data
    };
}

/**
 * @param {string} errorCode
 * @param {string} errorMessage
 * @param {object} [extra]  additional fields, e.g. { milestone: "M6_CAPTURE" }
 *
 * WHY `extra` EXISTS.
 *
 * `milestone` was hardcoded to "M1_CLIENT_ACCESS" with no way for a caller to
 * override it — successResponse() spreads `...data` after the default, so its
 * callers could; errorResponse() spread nothing, so its callers could not.
 *
 * The result: EVERY failure in EVERY milestone reported as M1_CLIENT_ACCESS.
 *
 * That is worse than a cosmetic defect. A Milestone 6 capture failure announced
 * itself as a Milestone 1 client-access failure, which points whoever is
 * debugging at the wrong module entirely. An error message that lies about where
 * it came from costs more than no error message at all.
 *
 * `extra` is spread LAST so a caller can override the default, exactly as
 * successResponse() already allowed. Existing two-argument callers are
 * unaffected — the response shape does not change for any of them.
 */
export function errorResponse(errorCode, errorMessage, extra = {}) {
    return {
        success: false,
        milestone: "M1_CLIENT_ACCESS",
        error_code: errorCode,
        error_message: errorMessage,
        timestamp: new Date().toISOString(),
        ...extra
    };
}
