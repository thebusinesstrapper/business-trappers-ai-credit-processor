from pathlib import Path

p = Path('src/inactiveRecheckSweep.js')
s = p.read_text()

old = '''        if (!id) continue;
        if (row.process_complete === true) continue; // terminal, never rechecked
        byId.set(id, {'''
new = '''        if (!id) continue;
        if (row.process_complete === true) continue; // terminal, never rechecked
        // Suspended is an explicit manual pause and is excluded from ALL automated
        // processing. Do not let an old inactive-memory flag pull a suspended
        // client back into the daily CreditHero recheck sweep.
        if (key(row.crc_client_status) === "suspended") continue;
        byId.set(id, {'''
if s.count(old) != 1:
    raise SystemExit(f'expected Supabase inactive enumeration block once, found {s.count(old)}')
s = s.replace(old, new, 1)

old_comment = ''' * included. Completed clients (Supabase process_complete = true) are excluded.'''
new_comment = ''' * included. Completed clients (Supabase process_complete = true) and clients whose
 * stored CRC status is Suspended are excluded from the automated recheck.'''
if s.count(old_comment) != 1:
    raise SystemExit(f'expected buildInactiveSet comment once, found {s.count(old_comment)}')
s = s.replace(old_comment, new_comment, 1)

p.write_text(s)

out = p.read_text()
if 'if (key(row.crc_client_status) === "suspended") continue;' not in out:
    raise SystemExit('suspended exclusion missing after patch')
if 'if (row.process_complete === true) continue;' not in out:
    raise SystemExit('complete exclusion unexpectedly removed')
