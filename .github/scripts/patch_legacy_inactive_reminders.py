from pathlib import Path

p = Path('src/inactiveWorkflow.js')
s = p.read_text()
old = '''    const decision = decideNoticeAction(state);\n    report.plannedAction = decision.action;\n    report.plannedReason = decision.reason;\n'''
new = '''    let decision = decideNoticeAction(state);\n\n    // LEGACY REMINDER CUTOVER. Before the 2026-09-01 race/episode fix, notice\n    // timestamps could survive a reactivation and later manufacture a stale\n    // "7-day reminder." Those pre-fix timestamps remain useful audit history,\n    // but they are never again authority to message a client. Only notices sent\n    // under the corrected episode logic may generate a future reminder.\n    const legacyReminderCutoffMs = Date.parse("2026-09-01T18:00:00Z");\n    const noticeMs = Date.parse(String(state.inactive_notice_sent_at ?? ""));\n    if (\n        decision.action === PLANNED_ACTION.SEND_REMINDER &&\n        Number.isFinite(noticeMs) &&\n        noticeMs < legacyReminderCutoffMs\n    ) {\n        decision = {\n            action: PLANNED_ACTION.NO_MESSAGE_DUE,\n            reason: "legacy_pre_fix_reminder_suppressed",\n        };\n    }\n\n    report.plannedAction = decision.action;\n    report.plannedReason = decision.reason;\n'''
if old not in s:
    raise SystemExit('guard failed: decision snippet not found')
if s.count(old) != 1:
    raise SystemExit(f'guard failed: decision snippet count {s.count(old)}')
p.write_text(s.replace(old, new, 1))
print('legacy inactive reminder cutover applied')
