from pathlib import Path

p = Path('src/openClient.js')
s = p.read_text()

branch_anchor = '''    // Team Members and other columns as well as Client Name. Navigate directly to
    // the known dashboard, then verify the resulting URL/ID before continuing.
    // No authoritative CRC id was supplied, so use the guarded name-search path.
    if (knownIdProvided) {
'''
branch_fixed = '''    // Team Members and other columns as well as Client Name. Navigate directly to
    // the known dashboard, then verify the resulting URL/ID before continuing.
    const knownIdProvided =
        knownCrcClientId != null && /^\\d+$/.test(String(knownCrcClientId).trim());

    if (knownIdProvided) {
'''

later_decl = '''    const knownIdProvided =
        knownCrcClientId != null && /^\\d+$/.test(String(knownCrcClientId).trim());

    if (knownIdProvided) {
'''

if s.count(branch_anchor) != 1:
    raise SystemExit(f'guard failed: expected one direct-id branch anchor, found {s.count(branch_anchor)}')

# Insert the declaration immediately before the direct-id branch.
s = s.replace(branch_anchor, branch_fixed, 1)

# Remove the later duplicate declaration only after the direct-id block.
direct_pos = s.find('Opening client dashboard directly by id')
later_pos = s.find(later_decl, direct_pos + 1)
if later_pos == -1:
    raise SystemExit('guard failed: later duplicate knownIdProvided declaration not found')

s = s[:later_pos] + '''    // No authoritative CRC id was supplied, so use the guarded name-search path.\n    if (knownIdProvided) {\n''' + s[later_pos + len(later_decl):]

if s.count('const knownIdProvided =') != 1:
    raise SystemExit(f'guard failed after patch: expected exactly one declaration, found {s.count("const knownIdProvided =")}')

p.write_text(s)
print('guarded knownIdProvided initialization fix applied')
