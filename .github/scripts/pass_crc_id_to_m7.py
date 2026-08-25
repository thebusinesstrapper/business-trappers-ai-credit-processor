from pathlib import Path

p = Path('src/processProductionClient.js')
s = p.read_text()
old = '''    const m7 = await runMilestone7({
        clientName,
        // Passed through to M6's client_state initialization.'''
new = '''    const m7 = await runMilestone7({
        clientName,
        // Preserve the authoritative CRC id already supplied by the queue. M6
        // accepts this value and openClient uses it to select the exact dashboard
        // row instead of relying on a potentially ambiguous name-only search.
        crcClientId: preflightId,
        // Passed through to M6's client_state initialization.'''
if s.count(old) != 1:
    raise SystemExit(f'expected M7 call anchor once, found {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

out = p.read_text()
if 'crcClientId: preflightId,' not in out:
    raise SystemExit('CRC id handoff missing after patch')
if 'currentRound: storedState?.current_round' not in out:
    raise SystemExit('currentRound handoff unexpectedly removed')
