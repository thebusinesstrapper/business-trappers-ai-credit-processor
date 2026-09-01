from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'guard failed: expected snippet not found in {path}')
    if s.count(old) != 1:
        raise SystemExit(f'guard failed: expected snippet occurs {s.count(old)} times in {path}')
    p.write_text(s.replace(old, new, 1))

# 1) Inactive workflow: require a timestamped positive inactive confirmation,
# suppress stale callers after a newer active/reactivated observation, and reset
# old notice/reminder dates for a genuinely new inactive episode.
p = Path('src/inactiveWorkflow.js')
s = p.read_text()
if 'evaluateInactiveMessageGate' not in s:
    s = s.replace(
        'import { loadOrCreateClientMemory, readClientState } from "./clientMemory.js";\n',
        'import { loadOrCreateClientMemory, readClientState } from "./clientMemory.js";\nimport { evaluateInactiveMessageGate } from "./inactiveMessageGate.js";\n',
        1,
    )
s = s.replace(
    'const { clientName, crcClientId: suppliedId, inactiveWorkflowApproved, noticeDiagnosticOnly } = opts;',
    'const { clientName, crcClientId: suppliedId, inactiveWorkflowApproved, noticeDiagnosticOnly, confirmedInactiveAt } = opts;',
    1,
)
old = '''    const decision = decideNoticeAction(state);\n    report.plannedAction = decision.action;\n    report.plannedReason = decision.reason;\n'''
new = '''    // SEND-TIME RACE GATE. The caller must supply when CreditHero was positively\n    // confirmed inactive. A stale inactive sweep is not allowed to outrank a\n    // newer active/reactivated observation written by another branch of the same run.\n    const initialGate = evaluateInactiveMessageGate(state, confirmedInactiveAt);\n    if (!initialGate.allow) {\n        report.plannedAction = PLANNED_ACTION.NO_MESSAGE_DUE;\n        report.plannedReason = initialGate.reason;\n        report.failureReason = `SUPPRESSED — ${initialGate.reason}. No inactive message or status write.`;\n        return report;\n    }\n\n    if (initialGate.newInactiveEpisode) {\n        // A prior inactive episode ended when monitoring reactivated. The old\n        // notice/reminder dates cannot carry into a later lapse and manufacture\n        // an immediate 7-day reminder. Reset the episode durably before deciding.\n        await recordCreditHeroState(crcClientId, {\n            inactive_notice_sent_at: null,\n            inactive_reminder_sent_at: null,\n            inactive_notice_last_error: null,\n        });\n        state = { ...state, inactive_notice_sent_at: null, inactive_reminder_sent_at: null };\n        report.inactiveEpisodeReset = true;\n    }\n\n    const decision = decideNoticeAction(state);\n    report.plannedAction = decision.action;\n    report.plannedReason = decision.reason;\n'''
if old not in s:
    raise SystemExit('guard failed: inactiveWorkflow decision snippet not found')
s = s.replace(old, new, 1)

# Re-read immediately before any write. This closes the window between the first
# memory read and opening a CRC browser session.
old2 = '''    try {\n\n    // ---- DIAGNOSTIC-ONLY SHORT PATH (temporary) ---------------------------\n'''
new2 = '''    try {\n\n    // FINAL SEND-TIME RACE GATE. Another branch may have confirmed the client\n    // active while this workflow was opening CRC. Re-read authoritative memory\n    // immediately before any inactive memory/status/message write.\n    const sendGateState = (await readClientState(String(crcClientId))) ?? {};\n    const sendGate = evaluateInactiveMessageGate(sendGateState, confirmedInactiveAt);\n    if (!sendGate.allow) {\n        report.plannedAction = PLANNED_ACTION.NO_MESSAGE_DUE;\n        report.plannedReason = sendGate.reason;\n        report.failureReason = `SUPPRESSED AT SEND TIME — ${sendGate.reason}. No inactive message or status write.`;\n        return report;\n    }\n\n    // ---- DIAGNOSTIC-ONLY SHORT PATH (temporary) ---------------------------\n'''
if old2 not in s:
    raise SystemExit('guard failed: inactiveWorkflow pre-write snippet not found')
s = s.replace(old2, new2, 1)
p.write_text(s)

# 2) Normal production inactive branch: timestamp the live positive inactive classification.
p = Path('src/processProductionClient.js')
s = p.read_text()
old = '''        const inactive = await runInactiveWorkflow({\n            clientName,\n            crcClientId: routeCrcId,\n            inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,\n'''
new = '''        const inactive = await runInactiveWorkflow({\n            clientName,\n            crcClientId: routeCrcId,\n            inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,\n            // Timestamp belongs to this live M7 CHS_NOT_ACTIVATED classification.\n            // runInactiveWorkflow compares it with any newer active/reactivated\n            // observation before it is allowed to message the client.\n            confirmedInactiveAt: new Date().toISOString(),\n'''
if old not in s:
    raise SystemExit('guard failed: production inactive call snippet not found')
s = s.replace(old, new, 1)
p.write_text(s)

# 3) Inactive recheck sweep: timestamp the live STILL_INACTIVE decision. If a
# normal branch reactivates the same client afterward, the workflow's send-time
# reread will suppress this now-stale sweep result.
p = Path('src/inactiveRecheckSweep.js')
s = p.read_text()
old = '''                        const notice = await runInactiveWorkflow({\n                            clientName: client.clientName,\n                            crcClientId: client.crcClientId,\n                            inactiveWorkflowApproved: true,\n                        });\n'''
new = '''                        const notice = await runInactiveWorkflow({\n                            clientName: client.clientName,\n                            crcClientId: client.crcClientId,\n                            inactiveWorkflowApproved: true,\n                            confirmedInactiveAt: new Date().toISOString(),\n                        });\n'''
if old not in s:
    raise SystemExit('guard failed: inactive sweep call snippet not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Focused pure tests for the race gate.
Path('src/inactiveMessageGate.test.js').write_text('''import assert from "node:assert/strict";\nimport { evaluateInactiveMessageGate } from "./inactiveMessageGate.js";\n\nconst oldNotice = "2026-08-25T08:00:00Z";\n\n// Stale inactive observation must lose to a newer reactivation.\nlet g = evaluateInactiveMessageGate({\n  credit_hero_access_state: "active",\n  last_credit_hero_check_at: "2026-09-01T08:15:10Z",\n  monitoring_reactivated_date: "2026-09-01T08:15:10Z",\n  inactive_notice_sent_at: oldNotice,\n}, "2026-09-01T07:20:00Z");\nassert.equal(g.allow, false);\nassert.equal(g.reason, "newer_reactivation_supersedes_inactive_confirmation");\n\n// A newer active check also suppresses even if reactivation timestamp is old.\ng = evaluateInactiveMessageGate({\n  credit_hero_access_state: "active",\n  last_credit_hero_check_at: "2026-09-01T08:15:10Z",\n  monitoring_reactivated_date: "2026-08-20T08:00:00Z",\n  inactive_notice_sent_at: oldNotice,\n}, "2026-09-01T07:20:00Z");\nassert.equal(g.allow, false);\nassert.equal(g.reason, "newer_active_check_supersedes_inactive_confirmation");\n\n// Genuine new lapse after a prior reactivation is allowed, but begins a new notice episode.\ng = evaluateInactiveMessageGate({\n  credit_hero_access_state: "active",\n  last_credit_hero_check_at: "2026-08-20T08:00:00Z",\n  monitoring_reactivated_date: "2026-08-20T08:00:00Z",\n  inactive_notice_sent_at: "2026-08-10T08:00:00Z",\n  inactive_reminder_sent_at: null,\n}, "2026-09-01T09:00:00Z");\nassert.equal(g.allow, true);\nassert.equal(g.newInactiveEpisode, true);\n\n// Continuous inactive episode with no newer active observation remains allowed.\ng = evaluateInactiveMessageGate({\n  credit_hero_access_state: "inactive",\n  last_credit_hero_check_at: "2026-09-01T07:00:00Z",\n  inactive_notice_sent_at: oldNotice,\n}, "2026-09-01T07:20:00Z");\nassert.equal(g.allow, true);\nassert.equal(g.newInactiveEpisode, false);\n\n// No proof timestamp: fail closed, no client message.\ng = evaluateInactiveMessageGate({}, null);\nassert.equal(g.allow, false);\n\nconsole.log("inactiveMessageGate race tests passed");\n''')

print('inactive-message race patch applied')
