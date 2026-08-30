from pathlib import Path

p = Path('src/processProductionClient.js')
s = p.read_text()

# The first audit patch should already be present. Keep this script idempotent.
required = [
    'import { recordSuccessfulProcessingRun } from "./processingRunHistory.js";',
    'let processingRunAudit = null;',
    'processingRunAudit,',
]
for token in required:
    if token not in s:
        raise SystemExit(f'guard failed: existing audit patch missing {token!r}')

old_start = '''export async function runProductionClient(data = {}) {
    const clientName =
'''
new_start = '''export async function runProductionClient(data = {}) {
    // Capture the real production-run start time before any preflight/browser
    // work. processing_run_history must not use its insert time as started_at.
    const processingRunStartedAt = new Date().toISOString();

    const clientName =
'''
if 'const processingRunStartedAt = new Date().toISOString();' not in s:
    if s.count(old_start) != 1:
        raise SystemExit(f'guard failed: production function start count={s.count(old_start)}')
    s = s.replace(old_start, new_start, 1)

old_arg = '''            reportDateUsed: exactReportDate,
            eligibilityReason:
'''
new_arg = '''            reportDateUsed: exactReportDate,
            startedAt: processingRunStartedAt,
            eligibilityReason:
'''
if 'startedAt: processingRunStartedAt,' not in s:
    if s.count(old_arg) != 1:
        raise SystemExit(f'guard failed: audit writer arg count={s.count(old_arg)}')
    s = s.replace(old_arg, new_arg, 1)

p.write_text(s)
print('processing audit start-time patch applied')
