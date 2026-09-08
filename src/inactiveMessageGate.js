// Pure send-time safety gate for CreditHero inactive notices/reminders.
// A stale or contradictory inactive observation must never outrank a newer
// active/reactivated observation. Client-facing inactive notices are high-risk,
// so a client that was positively active very recently must be reconfirmed on a
// later run before this gate permits any inactive status/message write.

function ms(value) {
    const n = Date.parse(String(value ?? ""));
    return Number.isFinite(n) ? n : null;
}

// Safety cooldown for active -> inactive transitions.
// If the durable state says the client was positively active within the last
// six hours, one contradictory inactive classification is not enough authority
// to message the client. The current run is suppressed; a genuinely inactive
// account will be reconfirmed by a later run after the recent-active window has
// expired. This intentionally favors a short notification delay over a false
// "your monitoring is inactive" notice to an active paying client.
const RECENT_ACTIVE_RECONFIRM_MS = 6 * 60 * 60 * 1000;

export function evaluateInactiveMessageGate(state = {}, confirmedInactiveAt = null) {
    const confirmedMs = ms(confirmedInactiveAt);
    if (confirmedMs == null) {
        return { allow: false, reason: "inactive_confirmation_missing_or_invalid", newInactiveEpisode: false };
    }

    const reactivatedMs = ms(state.monitoring_reactivated_date);
    const lastCheckMs = ms(state.last_credit_hero_check_at);
    const accessState = String(state.credit_hero_access_state ?? "").trim().toLowerCase();

    // A reactivation at or after the inactive observation wins. This is the race
    // that previously let an earlier inactive sweep send after normal processing
    // had already confirmed the client active and resumed work.
    if (reactivatedMs != null && reactivatedMs >= confirmedMs) {
        return { allow: false, reason: "newer_reactivation_supersedes_inactive_confirmation", newInactiveEpisode: false };
    }

    // A newer positive active check always wins over an older inactive
    // observation.
    if (accessState === "active" && lastCheckMs != null && lastCheckMs > confirmedMs) {
        return { allow: false, reason: "newer_active_check_supersedes_inactive_confirmation", newInactiveEpisode: false };
    }

    // HARD CONTRADICTION GUARD. If this same durable record says the client was
    // positively ACTIVE very recently, a single new inactive classification is
    // not enough authority to change CRC status or send a client-facing notice.
    // Require a later independent run to reconfirm inactivity. This specifically
    // prevents healthy CreditHero dashboard/promo-text false positives from
    // immediately reaching the inactive workflow.
    if (
        accessState === "active" &&
        lastCheckMs != null &&
        confirmedMs >= lastCheckMs &&
        confirmedMs - lastCheckMs < RECENT_ACTIVE_RECONFIRM_MS
    ) {
        return { allow: false, reason: "recent_active_check_requires_reconfirmation", newInactiveEpisode: false };
    }

    const priorNoticeMs = ms(state.inactive_notice_sent_at);

    // If the client was notified, later reactivated, and is now positively
    // inactive again, this is a NEW inactive episode. Old notice/reminder dates
    // must not cause an immediate stale 7-day reminder. Start with a fresh notice.
    const newInactiveEpisode =
        reactivatedMs != null &&
        confirmedMs > reactivatedMs &&
        (priorNoticeMs == null || reactivatedMs > priorNoticeMs);

    return { allow: true, reason: "current_inactive_confirmation_is_authoritative", newInactiveEpisode };
}
