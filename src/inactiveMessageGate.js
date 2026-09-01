// Pure send-time safety gate for CreditHero inactive notices/reminders.
// A stale inactive observation must never outrank a newer active/reactivated observation.

function ms(value) {
    const n = Date.parse(String(value ?? ""));
    return Number.isFinite(n) ? n : null;
}

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

    // Even if monitoring_reactivated_date is historical, a newer positive active
    // check wins over the older inactive observation.
    if (accessState === "active" && lastCheckMs != null && lastCheckMs > confirmedMs) {
        return { allow: false, reason: "newer_active_check_supersedes_inactive_confirmation", newInactiveEpisode: false };
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
