from pathlib import Path

p = Path('src/openCreditHero.js')
s = p.read_text()

old = '''        return {
            ok: false,
            nonActionable: noDestination,
            definitive: false,
            probe,
            diagnostics,
            reason: noDestination
                ? `The "${CREDIT_HERO_LABEL}" control has no usable href and the click did not ` +
                  `navigate — still on CRC (${url}). The control is present but dead.`
                : `The click did not navigate — still on CRC (${url}). The control was likely not yet wired up.`,
        };'''
new = '''        return {
            ok: false,
            // Staying on CRC proves only that the CreditHero entry control failed
            // to navigate. Even when the anchor has no usable href, that is NOT
            // proof the consumer's monitoring is inactive: CRC also uses working
            // href-less JavaScript anchors. Keep this a technical access failure.
            // Positive inactive classification is reserved for explicit disabled
            // controls or a CreditHero page carrying recognized inactive markers.
            nonActionable: false,
            deadControl: noDestination,
            definitive: false,
            probe,
            diagnostics,
            reason: noDestination
                ? `The "${CREDIT_HERO_LABEL}" control has no usable href and the click did not ` +
                  `navigate — still on CRC (${url}). This is a technical navigation failure, not ` +
                  `evidence that monitoring is inactive.`
                : `The click did not navigate — still on CRC (${url}). The control was likely not yet wired up.`,
        };'''

if s.count(old) != 1:
    raise SystemExit(f'expected exact dead-control block once, found {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)

# Static safety assertions: positive inactive paths must remain intact.
s = p.read_text()
required = [
    'preLanding.state === CH_LANDING_STATE.CREDENTIALS_OR_AUTH_FAILED',
    'requiresInactiveWorkflow: true',
    'attempts.some((a) => a.definitive) || attempts.every((a) => a.nonActionable)',
    'nonActionable: false,\n            deadControl: noDestination',
]
for marker in required:
    if marker not in s:
        raise SystemExit(f'missing required safety marker: {marker}')
