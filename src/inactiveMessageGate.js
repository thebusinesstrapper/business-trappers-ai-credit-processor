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
//
// Production runs are daily. A six-hour window was too short: an active client
// positively confirmed by the previous nightly recheck could be misclassified
// by the next night's normal queue roughly 24 hours later, and that single
// contradictory observation was then allowed to change CRC status and send an
// inactive notice BEFORE the inactive-recheck sweep got a chance to prove the
// client active again.
//
// Keep the positive ACTIVE observation authoritative for 30 hours. That spans
// one complete daily-run interval plus scheduling jitter. A single next-run
// contradictory inactive classification is therefore suppressed; the client
// must still be inactive on a later independent run before the normal queue may
// write Credit Monitoring Inactive or send a notice. The inactive-recheck sweep
// can still handle already-inactive clients because it first records the live
// recheck result; genuinely inactive clients do not remain protected by an old
// active state forever.
//
// This intentionally accepts a short delay for a newly inactive client rather
// than sending a false "your monitoring is inactive" notice to an active paying
// client.
const RECENT_ACTIVE_RECONFIRM_MS = 30 * 60 * 60 * 1000;

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
    // positively ACTIVE within the previous daily-run window, a single new
    // inactive classification is not enough authority to change CRC status or
    // send a client-facing notice. Require a later independent run to reconfirm
    // inactivity. This makes the nightly active recheck win over one-off CRC/UI
    // misreads instead of allowing the misread to message the client first.
    if (
        accessState === "active" &&
        lastCheckMs != null &&
        confirmedMs >= lastCheckMs &&
        confirmedMs - lastCheckMs < RECENT_ACTIVE_RECONFIRM_MS
    ) {
        return { allow: false, reason: "recent_active_check_requires_next_run_reconfirmation", newInactiveEpisode: false };
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
