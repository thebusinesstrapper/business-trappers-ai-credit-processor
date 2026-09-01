from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if new in s:
        print(f'{label}: already applied')
        return
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: guard failed, expected 1 occurrence, found {count}')
    p.write_text(s.replace(old, new, 1))
    print(f'{label}: patched')

# pipeline.js — actually consume item history and expose strategy/chain metadata
replace_once(
    'src/pipeline.js',
    '    const { currentRoundFloor = null } = options;\n',
    '    const { currentRoundFloor = null, itemHistory = {} } = options;\n',
    'pipeline options'
)
replace_once(
    'src/pipeline.js',
    '''    const strategies = await selectStrategy(decisions, {\n        currentRoundFloor,\n    });\n''',
    '''    const strategies = await selectStrategy(decisions, {\n        currentRoundFloor,\n        itemHistory,\n    });\n''',
    'pipeline strategy history'
)
replace_once(
    'src/pipeline.js',
    '''        item_decisions: decisions.itemDecisions ?? [],\n        letters: letterResult.letters ?? [],\n''',
    '''        item_decisions: decisions.itemDecisions ?? [],\n        // Durable strategy-memory metadata. These are reasoning records only;\n        // no binary letter contents are added to the JSON response.\n        item_strategies: strategies.itemStrategies ?? [],\n        dispute_chain_items: chain.items ?? [],\n        strategy_summary: strategies.summary ?? null,\n        letters: letterResult.letters ?? [],\n''',
    'pipeline history metadata'
)

# milestone7.js — pass stored item memory into pure pipeline
replace_once(
    'src/milestone7.js',
    '''        const pipeline = await runPipeline(report, identity, { currentRoundFloor });\n''',
    '''        const pipeline = await runPipeline(report, identity, {\n            currentRoundFloor,\n            itemHistory: data.itemHistory ?? {},\n        });\n''',
    'm7 item history handoff'
)

# processProductionClient.js — read item history before M7 and write only after confirmed delivery
replace_once(
    'src/processProductionClient.js',
    'import { recordSuccessfulProcessingRun } from "./processingRunHistory.js";\n',
    'import { recordSuccessfulProcessingRun } from "./processingRunHistory.js";\nimport { readItemDisputeHistory, recordDeliveredItemHistory } from "./itemDisputeHistory.js";\n',
    'production item history import'
)
replace_once(
    'src/processProductionClient.js',
    '''    let storedState = null;\n\n    if (preflightId) {\n        storedState = await readClientState(preflightId).catch(() => null);\n''',
    '''    let storedState = null;\n    let storedItemHistory = {};\n    let itemHistoryRead = { ok: true, itemHistory: {}, rows: [] };\n\n    if (preflightId) {\n        storedState = await readClientState(preflightId).catch(() => null);\n        itemHistoryRead = await readItemDisputeHistory(preflightId).catch((error) => ({\n            ok: false,\n            reason: "item_history_read_exception",\n            detail: error.message,\n            itemHistory: {},\n            rows: [],\n        }));\n        storedItemHistory = itemHistoryRead?.itemHistory ?? {};\n\n        if (itemHistoryRead?.ok !== true) {\n            console.error(\n                `item_dispute_history read failed for CRC ${preflightId}: ` +\n                `${itemHistoryRead?.reason ?? "unknown"}${itemHistoryRead?.detail ? ` — ${itemHistoryRead.detail}` : ""}`\n            );\n        }\n''',
    'production item history read'
)
replace_once(
    'src/processProductionClient.js',
    '''        currentRound: storedState?.current_round != null && Number.isInteger(Number(storedState.current_round)) && Number(storedState.current_round) > 0\n            ? Number(storedState.current_round)\n            : null,\n    });\n''',
    '''        currentRound: storedState?.current_round != null && Number.isInteger(Number(storedState.current_round)) && Number(storedState.current_round) > 0\n            ? Number(storedState.current_round)\n            : null,\n        itemHistory: storedItemHistory,\n    });\n''',
    'production m7 history handoff'
)
replace_once(
    'src/processProductionClient.js',
    '''    if (deliveryConfirmed && lifecycleSucceeded) {\n        const exactReportDate = successCapture?.lastReportDate ?? null;\n''',
    '''    let itemHistoryAudit = null;\n\n    if (deliveryConfirmed && lifecycleSucceeded) {\n        itemHistoryAudit = await recordDeliveredItemHistory({\n            crcClientId,\n            roundCompleted: deliveredRound,\n            chainItems: Array.isArray(m7?.dispute_chain_items) ? m7.dispute_chain_items : [],\n        }).catch((error) => ({\n            ok: false,\n            reason: "item_history_writer_exception",\n            detail: error.message,\n            written: 0,\n        }));\n\n        if (itemHistoryAudit?.ok !== true) {\n            console.error(\n                `item_dispute_history persistence failed for CRC ${crcClientId}, round ${deliveredRound}: ` +\n                `${itemHistoryAudit?.reason ?? "write_errors"}${itemHistoryAudit?.detail ? ` — ${itemHistoryAudit.detail}` : ""}`\n            );\n        } else {\n            console.log(\n                `item_dispute_history persisted for CRC ${crcClientId}, round ${deliveredRound}: ` +\n                `${itemHistoryAudit.written ?? 0} written, ${itemHistoryAudit.duplicates ?? 0} duplicate-safe.`\n            );\n        }\n\n        const exactReportDate = successCapture?.lastReportDate ?? null;\n''',
    'production success history write'
)
replace_once(
    'src/processProductionClient.js',
    '''        processingRunAudit,\n        m7Summary: {\n''',
    '''        processingRunAudit,\n        itemHistoryRead: {\n            ok: itemHistoryRead?.ok === true,\n            rows: Array.isArray(itemHistoryRead?.rows) ? itemHistoryRead.rows.length : 0,\n            reason: itemHistoryRead?.ok === true ? null : (itemHistoryRead?.reason ?? "unknown"),\n        },\n        itemHistoryAudit,\n        m7Summary: {\n''',
    'production return history diagnostics'
)

print('All item-history wiring patches applied.')
